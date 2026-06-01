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
const API = 'https://localhost:3001'

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

interface TrackedPlaylist {
  spotify_playlist_id: string
  name:                string
  owner_name:          string
  last_polled_at:      string
}

/**
 * usePlaylists — fetches tracked playlists and exposes add/remove functions.
 * Playlists are added by Spotify URL or ID now (no more username lookup).
 */
function usePlaylists() {
  const [playlists, setPlaylists] = useState<TrackedPlaylist[]>([])
  const [addError, setAddError]   = useState<string | null>(null)
  const [adding, setAdding]       = useState(false)
  const [tick, setTick]           = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const res  = await fetch(`${API}/api/playlists`)
      const data = await res.json() as TrackedPlaylist[]
      if (!cancelled) setPlaylists(data)
    }
    load()
    return () => { cancelled = true }
  }, [tick])

  const reload = useCallback(() => setTick(t => t + 1), [])

  const addPlaylist = async (input: string) => {
    setAdding(true)
    setAddError(null)
    try {
      const res  = await fetch(`${API}/api/playlists`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ input }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAddError(data.error ?? 'Failed to add playlist')
        return false
      }
      reload()
      return true
    } catch {
      setAddError('Could not reach the server')
      return false
    } finally {
      setAdding(false)
    }
  }

  const removePlaylist = async (spotifyId: string) => {
    setPlaylists(prev => prev.filter(p => p.spotify_playlist_id !== spotifyId))
    await fetch(`${API}/api/playlists/${spotifyId}`, { method: 'DELETE' })
  }

  return { playlists, addError, adding, addPlaylist, removePlaylist }
}
/**
 * useSpotifyAuth — checks if the user has connected their Spotify account.
 * Also handles the ?connected=true redirect that comes back from OAuth.
 */
function useSpotifyAuth() {
  // Read URL params synchronously on first render so we never need setState inside an effect
  const [connected, setConnected] = useState<boolean | null>(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('connected') === 'true' ? true : null
  })

  useEffect(() => {
    // Clean the ?connected=true from the URL (purely cosmetic, no setState)
    if (window.location.search.includes('connected=true')) {
      window.history.replaceState({}, '', '/')
      return // initial state already set to true above
    }
    // Ask the server if we already have OAuth tokens stored
    fetch(`${API}/api/auth/status`)
      .then(r => r.json())
      .then((data: { connected: boolean }) => setConnected(data.connected))
      .catch(() => setConnected(false))
  }, [])

  const login = () => { window.location.href = `${API}/api/auth/login` }

  return { connected, login }
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
      // Run the poll + notification reload + minimum delay simultaneously.
      // Promise.all waits for ALL of them before continuing.
      await Promise.all([
        fetch(`${API}/api/poll`, { method: 'POST' }).then(() => afterPollRef.current()),
        new Promise(resolve => setTimeout(resolve, 1500)) // 1.5s minimum so it feels real
      ])
      // Wait for React to finish painting any new cards onto the screen.
      // Without this, the spinner can stop a frame before new content appears.
      // requestAnimationFrame fires right before the next browser paint.
      await new Promise(resolve => requestAnimationFrame(resolve))
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

/** A pill showing a tracked playlist with a remove button */
function PlaylistPill({
  playlist,
  onRemove,
}: {
  playlist: TrackedPlaylist
  onRemove: (spotifyId: string) => void
}) {
  const initials = playlist.name.slice(0, 2).toUpperCase()
  return (
    <div className="friend-pill">
      <div className="friend-avatar">{initials}</div>
      <span>
        <strong>{playlist.name}</strong>
        <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
          by {playlist.owner_name}
        </span>
      </span>
      <button
        className="friend-remove"
        onClick={() => onRemove(playlist.spotify_playlist_id)}
        title="Stop tracking"
      >
        ×
      </button>
    </div>
  )
}

/** The "Add a playlist" form — accepts a Spotify playlist URL or bare ID */
function AddPlaylistForm({
  onAdd,
  adding,
  error,
}: {
  onAdd: (input: string) => Promise<boolean>
  adding: boolean
  error: string | null
}) {
  const [value, setValue] = useState('')

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!value.trim()) return
    const success = await onAdd(value.trim())
    if (success) setValue('')
  }

  return (
    <div className="add-friend-form">
      {error && <div className="error-banner">⚠️ {error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="playlist-input">
              Spotify Playlist URL or ID
            </label>
            <input
              id="playlist-input"
              className="form-input"
              type="text"
              placeholder="https://open.spotify.com/playlist/..."
              value={value}
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
          💡 In Spotify: right-click any playlist → Share → Copy link to playlist
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

  const notifs    = useNotifications()
  const playlists = usePlaylists()
  const { connected } = useSSE(notifs.reload)
  const { polling, pollNow } = usePollNow(notifs.fetchNow)
  const spotify = useSpotifyAuth()

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
            disabled={polling || spotify.connected !== true}
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
              Playlists ({playlists.playlists.length})
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
                    When songs get added to tracked playlists, they'll show up here
                    with the album art. Check back soon!
                  </div>
                </div>
              )}

              {feedItems.length > 0 && (
                <div className="feed-grid">
                  {feedItems.map(n => (
                    <FeedCard key={n.id} n={n} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── PLAYLISTS TAB ─────────────────────── */}
          {activeTab === 'friends' && (
            <>
              <AddPlaylistForm
                onAdd={playlists.addPlaylist}
                adding={playlists.adding}
                error={playlists.addError}
              />

              {playlists.playlists.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">🎵</div>
                  <div className="empty-title">No playlists tracked yet</div>
                  <div className="empty-body">
                    Paste a Spotify playlist link above to start tracking it.
                  </div>
                </div>
              ) : (
                <div className="friends-list">
                  {playlists.playlists.map(p => (
                    <PlaylistPill key={p.spotify_playlist_id} playlist={p} onRemove={playlists.removePlaylist} />
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
