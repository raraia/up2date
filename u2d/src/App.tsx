// =============================================================
// App.tsx — The entire frontend
// =============================================================
// React works by breaking the UI into "components" — reusable
// pieces of UI that manage their own state and re-render when
// that state changes.
//
// This file has:
//   - Custom hooks (useNotifications, useFriends, useSSE)
//     → hooks are functions that manage stateful logic
//   - Small helper components (NotificationCard, FriendPill, etc.)
//   - The main App component that wires it all together
// =============================================================

import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'
import { Bell } from 'lucide-react'



// The URL of our backend server
const API = 'http://localhost:3001'

// =============================================================
// TYPE DEFINITIONS
// These mirror the shape of the data our backend sends us.
// TypeScript uses them to catch bugs at compile time.
// =============================================================


interface Notification {
  id: number
  type: 'track_added' | 'track_removed' | 'playlist_created' | 'playlist_deleted' | 'playlist_renamed'
  playlist_name: string
  track_name: string | null
  artist_name: string | null
  extra_data: string | null  // JSON string — we'll parse it when needed
  is_read: 0 | 1
  created_at: string          // ISO date string
  friend_display_name: string
  friend_username: string
}

interface Friend {
  id: number
  spotify_username: string
  display_name: string
  added_at: string
}

// =============================================================
// UTILITY FUNCTIONS
// =============================================================

/**
 * Turn a notification object into a human-readable sentence + icon.
 * This is a pure function — same input always gives same output.
 */
function describeNotification(n: Notification): {
  sentence: string
  detail: string
  icon: string
  iconColor: 'green' | 'red' | 'blue' | 'yellow'
} {
  const name = n.friend_display_name || n.friend_username

  switch (n.type) {
    case 'track_added':
      return {
        sentence:  `${name} added a track to`,
        detail:    `"${n.track_name}" by ${n.artist_name} — ${n.playlist_name}`,
        icon:      '➕',
        iconColor: 'green',
      }
    case 'track_removed':
      return {
        sentence:  `${name} removed a track from`,
        detail:    `"${n.track_name}" by ${n.artist_name} — ${n.playlist_name}`,
        icon:      '➖',
        iconColor: 'red',
      }
    case 'playlist_created':
      return {
        sentence:  `${name} created a new playlist`,
        detail:    n.playlist_name,
        icon:      '🎵',
        iconColor: 'blue',
      }
    case 'playlist_deleted':
      return {
        sentence:  `${name} deleted a playlist`,
        detail:    n.playlist_name,
        icon:      '🗑️',
        iconColor: 'red',
      }
    case 'playlist_renamed': {
      // extra_data is a JSON string like: {"oldName": "Old Name"}
      const extra = n.extra_data ? JSON.parse(n.extra_data) : {}
      return {
        sentence:  `${name} renamed a playlist`,
        detail:    `"${extra.oldName}" → "${n.playlist_name}"`,
        icon:      '✏️',
        iconColor: 'yellow',
      }
    }
    default:
      return { sentence: 'Something changed', detail: '', icon: '🔔', iconColor: 'green' }
  }
}

/**
 * Format a timestamp into a readable date + time string.
 * Uses Intl.DateTimeFormat — built into modern browsers, no library needed!
 * Example output: "May 27, 3:45 PM"  (current year omitted to save space)
 *                 "Jan 3 2025, 9:12 AM"  (past year shown)
 */
function formatTime(isoString: string): string {
  const date = new Date(isoString)
  const now  = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()

  return new Intl.DateTimeFormat('en-US', {
    month:  'short',
    day:    'numeric',
    year:   sameYear ? undefined : 'numeric', // only show year if it's not this year
    hour:   'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date)
}

// =============================================================
// CUSTOM HOOKS
// Hooks are React's way of sharing stateful logic between components.
// They always start with "use" by convention.
// =============================================================

/**
 * useNotifications — fetches notifications from the API and exposes
 * functions to mark them as read.
 *
 * WHY THE TICK PATTERN?
 * The old version used useCallback to create a `load` function, then passed
 * it as a dependency to useEffect. In React 19 Strict Mode this can cause
 * setState calls to loop. The fix: define the async fetch *inside* useEffect,
 * and use a `tick` counter to re-trigger it when we want a fresh fetch.
 * Incrementing `tick` → effect re-runs → fresh data. Simple and safe.
 */
function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  // Incrementing this number causes the useEffect below to re-run
  const [tick, setTick] = useState(0)

  useEffect(() => {
    // Track whether this effect run is still "current".
    // If the component unmounts or the effect re-runs before the fetch
    // finishes, `cancelled` is set to true and we skip the setState calls.
    // Without this, you can get "setState on an unmounted component" warnings.
    let cancelled = false

    async function load() {
      try {
        const res  = await fetch(`${API}/api/notifications`)
        const data = await res.json() as Notification[]
        if (!cancelled) { setNotifications(data); setError(null) }
      } catch {
        if (!cancelled) setError('Could not reach the server. Is it running?')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    // Cleanup function: mark this run as cancelled when the effect tears down
    return () => { cancelled = true }
  }, [tick]) // re-run whenever tick changes

  // reload() bumps tick → triggers the effect above → fresh fetch
  // Used by the SSE hook to refresh when the server pushes a change.
  const reload = useCallback(() => setTick(t => t + 1), [])

  // fetchNow() does the same thing but actually returns a Promise that resolves
  // when the fetch completes — so callers can await it and know when data is fresh.
  // reload() can't do this because it just bumps a counter; the fetch happens
  // asynchronously inside a useEffect, invisible to the caller.
  const fetchNow = useCallback(async () => {
    try {
      const res  = await fetch(`${API}/api/notifications`)
      const data = await res.json() as Notification[]
      setNotifications(data)
      setError(null)
    } catch {
      setError('Could not reach the server. Is it running?')
    }
  }, [])

  const markRead = async (id: number) => {
    // Optimistic update — change the UI immediately, then confirm with server.
    // Feels instant rather than waiting for the round-trip.
    setNotifications(prev =>
      prev.map(n => n.id === id ? { ...n, is_read: 1 as const } : n)
    )
    await fetch(`${API}/api/notifications/${id}/read`, { method: 'PATCH' })
  }

  const markAllRead = async () => {
    setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 as const })))
    await fetch(`${API}/api/notifications/mark-all-read`, { method: 'POST' })
  }

  const unreadCount = notifications.filter(n => n.is_read === 0).length

  return { notifications, loading, error, unreadCount, markRead, markAllRead, reload, fetchNow }
}

/**
 * useFriends — fetches friends list and exposes add/remove functions.
 * Same tick pattern as useNotifications for the same reasons.
 */
function useFriends() {
  const [friends, setFriends]   = useState<Friend[]>([])
  const [loading, setLoading]   = useState(true)
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding]     = useState(false)
  const [tick, setTick]         = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const res  = await fetch(`${API}/api/friends`)
      const data = await res.json() as Friend[]
      if (!cancelled) { setFriends(data); setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [tick])

  // Bumping tick causes the useEffect above to re-run and re-fetch friends
  const reloadFriends = useCallback(() => setTick(t => t + 1), [])

  const addFriend = async (spotifyUsername: string) => {
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch(`${API}/api/friends`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        // JSON.stringify converts a JS object to a JSON string
        body:    JSON.stringify({ spotifyUsername }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAddError(data.error ?? 'Failed to add friend')
        return false
      }
      reloadFriends() // bump tick → useEffect re-runs → fresh list
      return true
    } catch {
      setAddError('Could not reach the server')
      return false
    } finally {
      setAdding(false)
    }
  }

  const removeFriend = async (id: number) => {
    setFriends(prev => prev.filter(f => f.id !== id)) // optimistic remove
    await fetch(`${API}/api/friends/${id}`, { method: 'DELETE' })
  }


  return { friends, loading, addError, adding, addFriend, removeFriend }
}
// usePollNow - sends a POST to /api/poll, then refreshes notifications,
// then stops the spinner. The spinner runs for the full real duration —
// no fake timeout, it stops exactly when the data is fresh.

function usePollNow(afterPoll: () => Promise<void>) {
  const [polling, setPolling] = useState(false)

  // Store the callback in a ref so it's never a dependency of pollNow.
  // Same pattern as useSSE — keeps the function stable.
  const afterPollRef = useRef(afterPoll)
  useEffect(() => { afterPollRef.current = afterPoll }, [afterPoll])

  const pollNow = async () => {
    setPolling(true)
    try {
      // Run the poll + notification reload + a minimum delay all at the same time.
      // Promise.all waits for ALL of them to finish before continuing.
      // The minimum delay means the spinner always shows for at least 1s,
      // even when Spotify is rate-limited and everything completes instantly.
      // Without it, setPolling flips true→false faster than React can repaint.
      await Promise.all([
        fetch(`${API}/api/poll`, { method: 'POST' }).then(() => afterPollRef.current()),
        new Promise(resolve => setTimeout(resolve, 1000)) // minimum 1s spinner
      ])
    } finally {
      setPolling(false)
    }
  }

  return { pollNow, polling }
}


/**
 * useSSE — connects to the server's SSE stream and fires a callback
 * whenever the server broadcasts new notifications.
 *
 * SSE (Server-Sent Events) is a browser API that keeps a connection
 * open to the server. The server can push messages any time — like
 * a one-way WebSocket.
 *
 * WHY useRef FOR THE CALLBACK?
 * If we put `onNewNotifications` in the dependency array, the effect
 * re-runs every time that function reference changes — which closes and
 * reopens the SSE connection and can trigger the setState loop warning.
 *
 * useRef gives us a stable box that we can update on every render
 * WITHOUT it being a dependency. The EventSource is created once,
 * but callbackRef.current always points to the latest version of the
 * callback — best of both worlds.
 */
function useSSE(onNewNotifications: () => void) {
  const [connected, setConnected] = useState(false)

  // useRef creates a mutable container that persists across renders.
  // Updating .current does NOT cause a re-render (unlike useState).
  const callbackRef = useRef(onNewNotifications)

  // Keep the ref in sync with the latest callback.
  // React 19 requires ref updates to happen inside effects, not during render.
  // This effect re-runs whenever onNewNotifications changes, keeping the ref
  // current — but it does NOT affect the EventSource effect below.
  useEffect(() => {
    callbackRef.current = onNewNotifications
  }, [onNewNotifications])

  useEffect(() => {
    // EventSource is the browser's built-in SSE client
    const es = new EventSource(`${API}/api/events`)

    es.addEventListener('connected', () => setConnected(true))

    // This fires when the poller finds new changes.
    // We call callbackRef.current (not onNewNotifications directly) so we
    // always get the latest version of the callback without re-running this effect.
    es.addEventListener('new-notifications', () => {
      callbackRef.current()
    })

    es.onerror = () => setConnected(false)

    // Cleanup: close the connection when the component unmounts
    return () => es.close()
  }, []) // empty [] = open the connection exactly once, never recreate it

  return { connected }
}

// =============================================================
// SUB-COMPONENTS
// =============================================================

/** One row in the notification feed */
function NotificationCard({
  notification,
  onRead,
}: {
  notification: Notification
  onRead: (id: number) => void
}) {
  const { sentence, detail, icon, iconColor } = describeNotification(notification)
  const isUnread = notification.is_read === 0

  return (
    <div
      className={[
        'notification-card',
        isUnread ? 'unread' : '',
        `type-${notification.type}`,
      ].join(' ')}
      onClick={() => isUnread && onRead(notification.id)}
      title={isUnread ? 'Click to mark as read' : ''}
    >
      {/* Coloured icon circle */}
      <div className={`notif-icon ${iconColor}`}>{icon}</div>

      {/* Text content */}
      <div className="notif-body">
        <div className="notif-title">
          <strong>{notification.friend_display_name}</strong>{' '}
          {sentence.replace(notification.friend_display_name, '').trim()}
        </div>
        <div className="notif-detail">{detail}</div>
      </div>

      {/* Timestamp */}
      <div className="notif-time">{formatTime(notification.created_at)}</div>
    </div>
  )
}

/** A pill showing a tracked friend's name with a remove button */
function FriendPill({
  friend,
  onRemove,
}: {
  friend: Friend
  onRemove: (id: number) => void
}) {
  const initials = (friend.display_name || friend.spotify_username)
    .slice(0, 2)
    .toUpperCase()

  return (
    <div className="friend-pill">
      <div className="friend-avatar">{initials}</div>
      <span>{friend.display_name || friend.spotify_username}</span>
      <button
        className="friend-remove"
        onClick={() => onRemove(friend.id)}
        title="Stop tracking"
      >
        ×
      </button>
    </div>
  )
}

/** The "Add a friend" form */
function AddFriendForm({
  onAdd,
  adding,
  error,
}: {
  onAdd: (username: string) => Promise<boolean>
  adding: boolean
  error: string | null
}) {
  // useState for the text input — React controls the input value
  const [value, setValue] = useState('')

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault() // prevent browser from refreshing the page
    if (!value.trim()) return
    const success = await onAdd(value.trim())
    if (success) setValue('') // clear input on success
  }

  return (
    <div className="add-friend-form">
      {error && <div className="error-banner">⚠️ {error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="form-row">
          <div className="form-group">
            {/*
              ── YOUR TURN ──────────────────────────────────────
              This is the input that takes a Spotify username.
              The label, placeholder, and hint text are all here.
              You can customize the wording however you like!
            */}
            <label className="form-label" htmlFor="spotify-username">
              Friend's Spotify Username
            </label>
            <input
              id="spotify-username"
              className="form-input"
              type="text"
              placeholder="e.g. philik3"
              value={value}
              // onChange fires on every keystroke — we update `value` so React stays in sync
              onChange={e => setValue(e.target.value)}
              disabled={adding}
            />
          </div>

          <button
            type="submit"
            className="btn btn-accent"
            disabled={adding || !value.trim()}
          >
            {adding ? <span className="spinner" /> : 'Track'}
          </button>
        </div>

        <p className="form-hint">
          💡 Find a username by opening their Spotify profile → ⋯ → Share → Copy link.
          The ID is at the end of the URL.
        </p>
      </form>
    </div>
  )
}

// =============================================================
// FEED CARD — Instagram-style card for track additions
// Only used on the Home tab. Shows album art + track info.
// =============================================================

function FeedCard({ n }: { n: Notification }) {
  // Parse extra_data JSON to get the album art URL + track ID we stored in differ.ts
  const extra      = n.extra_data ? JSON.parse(n.extra_data) as { albumArt?: string; trackId?: string; albumId?: string } : {}
  const art        = extra.albumArt
  // Link to the album/EP page so you can see the full release context.
  // Falls back to the track page if somehow albumId wasn't stored.
  const spotifyUrl = extra.albumId
    ? `https://open.spotify.com/album/${extra.albumId}`
    : extra.trackId
      ? `https://open.spotify.com/track/${extra.trackId}`
      : null

  const handleClick = () => {
    if (spotifyUrl) window.open(spotifyUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      className="feed-card"
      onClick={handleClick}
      style={spotifyUrl ? { cursor: 'pointer' } : undefined}
      title={spotifyUrl ? `Open "${n.track_name}" in Spotify` : undefined}
    >
      {/* ── Album art ── */}
      <div className="feed-card-art">
        {art
          ? <img src={art} alt={n.track_name ?? 'album art'} />
          : <div className="feed-card-placeholder">🎵</div>
        }
      </div>

      {/* ── Track info below the image ── */}
      <div className="feed-card-info">
        <div className="feed-card-track">{n.track_name}</div>
        <div className="feed-card-artist">{n.artist_name}</div>
        <div className="feed-card-meta">
          {/* Template literals (``) let you embed variables inside strings with ${} */}
          Added to <strong>{n.playlist_name}</strong>
        </div>
        <div className="feed-card-footer">
          <span className="feed-card-friend">{n.friend_display_name}</span>
          <span className="feed-card-time">{formatTime(n.created_at)}</span>
        </div>
      </div>
    </div>
  )
}

// =============================================================
// MAIN APP COMPONENT
// =============================================================

export default function App() {
  // Two tabs for the left column: Home feed or Friends management
  const [activeTab, setActiveTab] = useState<'home' | 'friends'>('home')

  const notifs  = useNotifications()
  const friends = useFriends()
  const { connected } = useSSE(notifs.reload)
  const { polling, pollNow } = usePollNow(notifs.fetchNow)

  // The home feed only shows track additions — those are the ones with album art.
  // .filter() returns a new array containing only items where the condition is true.
  const feedItems = notifs.notifications.filter(n => n.type === 'track_added')

  return (
    <div className="app">

      {/* ── Navbar ──────────────────────────────────── */}
      <nav className="navbar">
        <div className="nav-brand">
          <div className="nav-dot" />
          Up2Date
        </div>

        <div className="nav-right">
          <button
            className="btn btn-ghost"
            onClick={pollNow}
            disabled={polling}
            title={connected ? 'Live' : 'Disconnected'}
          >
            <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
            {polling ? <><span className="spinner" /> loading...</> : '↻ Refresh?'}
          </button>

          <div className="bell-wrapper">
            <Bell size={18} />
            {notifs.unreadCount > 0 && (
              <span className="badge">{notifs.unreadCount}</span>
            )}
          </div>
        </div>
      </nav>

      {/* ── Two-column layout ───────────────────────── */}
      {/* CSS grid splits the page: main content left, notification sidebar right */}
      <div className="layout">

        {/* ── LEFT COLUMN ─────────────────────────── */}
        <div className="feed-column">

          {/* Tabs just for the left column */}
          <div className="tabs">
            <button
              className={`tab ${activeTab === 'home' ? 'active' : ''}`}
              onClick={() => setActiveTab('home')}
            >
              Home
            </button>
            <button
              className={`tab ${activeTab === 'friends' ? 'active' : ''}`}
              onClick={() => setActiveTab('friends')}
            >
              Friends ({friends.friends.length})
            </button>
          </div>

          {/* ── HOME FEED ─────────────────────────── */}
          {activeTab === 'home' && (
            <>
              {notifs.loading && (
                <div className="empty-state">
                  <div className="spinner" style={{ margin: '0 auto' }} />
                </div>
              )}

              {notifs.error && (
                <div className="error-banner">⚠️ {notifs.error}</div>
              )}

              {!notifs.loading && feedItems.length === 0 && (
                <div className="empty-state">
                  <div className="empty-icon">🎧</div>
                  <div className="empty-title">Nothing here yet</div>
                  <div className="empty-body">
                    When your friends add songs to their playlists, they'll show up here
                    with the album art. Check back soon!
                  </div>
                </div>
              )}

              {/* Instagram-style grid of feed cards */}
              {feedItems.length > 0 && (
                <div className="feed-grid">
                  {feedItems.map(n => (
                    <FeedCard key={n.id} n={n} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── FRIENDS TAB ───────────────────────── */}
          {activeTab === 'friends' && (
            <>
              <AddFriendForm
                onAdd={friends.addFriend}
                adding={friends.adding}
                error={friends.addError}
              />

              {friends.friends.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">👥</div>
                  <div className="empty-title">No friends tracked yet</div>
                  <div className="empty-body">
                    Add a Spotify username above to start tracking their playlists.
                  </div>
                </div>
              ) : (
                <div className="friends-list">
                  {friends.friends.map(f => (
                    <FriendPill key={f.id} friend={f} onRemove={friends.removeFriend} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── RIGHT SIDEBAR — always visible ──────── */}
        {/* Shows ALL notification types (adds, removes, renames, etc.) */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <span className="sidebar-title">Activity</span>
            {notifs.unreadCount > 0 && (
              <button className="btn btn-ghost" style={{ fontSize: '11px', padding: '4px 8px' }} onClick={notifs.markAllRead}>
                Mark all read
              </button>
            )}
          </div>

          {notifs.notifications.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '16px' }}>
              No activity yet
            </div>
          ) : (
            <div className="notification-list">
              {notifs.notifications.map(n => (
                <NotificationCard key={n.id} notification={n} onRead={notifs.markRead} />
              ))}
            </div>
          )}
        </aside>

      </div>
    </div>
  )
}
