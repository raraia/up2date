// =============================================================
// db.ts — JSON File Database
// =============================================================
// Instead of SQLite (which needs native C++ compilation), we're
// using a plain JSON file as our database. This is great for learning
// because you can literally open "up2date-data.json" and see your data!
//
// The tradeoff: slightly slower for huge datasets, no SQL query language.
// For a playlist tracker, this is completely fine.
//
// How it works:
//   - On startup we read the JSON file into memory
//   - Every write operation updates memory AND saves to disk
//   - On the next server restart, we load from disk and pick up where we left off
// =============================================================

import fs   from 'fs';
import path from 'path';

// =============================================================
// TYPE DEFINITIONS
// These describe the shape of every object in our "database"
// =============================================================

export interface Friend {
  id:               number;
  spotify_username: string;
  display_name:     string;
  added_at:         string; // ISO date string e.g. "2024-01-15T10:30:00.000Z"
}

export interface Playlist {
  id:                  number;
  friend_id:           number;
  spotify_playlist_id: string;
  name:                string;
  last_polled_at:      string;
}

export interface PlaylistTrack {
  playlist_id:      number;
  spotify_track_id: string;
  track_name:       string;
  artist_name:      string;
}

export interface Notification {
  id:                  number;
  friend_id:           number;
  playlist_spotify_id: string;
  playlist_name:       string;
  type:                'track_added' | 'track_removed' | 'playlist_created' | 'playlist_deleted' | 'playlist_renamed';
  track_name:          string | null;
  artist_name:         string | null;
  extra_data:          string | null; // JSON string
  is_read:             0 | 1;         // 0 = unread, 1 = read (matching SQL convention)
  created_at:          string;
}

// The full structure of our JSON "database"
interface DbSchema {
  friends:         Friend[];
  playlists:       Playlist[];
  playlist_tracks: PlaylistTrack[];
  notifications:   Notification[];
  // Auto-increment counters (since we don't have SQLite's AUTOINCREMENT)
  _counters: {
    friends:       number;
    playlists:     number;
    notifications: number;
  };
  // Persists Spotify rate limit across server restarts.
  // Stores a Unix timestamp (ms) — if Date.now() is less than this, we're still banned.
  // Without this, every restart would forget the ban and immediately re-trigger it.
  _rateLimitedUntil: number;
}

// =============================================================
// FILE LOADING AND SAVING
// =============================================================

const DB_PATH = path.join(process.cwd(), 'up2date-data.json');

// Load data from disk. If the file doesn't exist yet, return empty defaults.
function loadData(): DbSchema {
  if (!fs.existsSync(DB_PATH)) {
    return {
      friends:            [],
      playlists:          [],
      playlist_tracks:    [],
      notifications:      [],
      _counters:          { friends: 0, playlists: 0, notifications: 0 },
      _rateLimitedUntil:  0, // 0 means "not rate limited"
    };
  }
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw) as DbSchema;
}

// Save the current in-memory state to disk.
// JSON.stringify with indentation makes the file human-readable.
function saveData(data: DbSchema): void {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// Load once when the module is first imported.
// All subsequent reads/writes use this in-memory copy.
let data = loadData();
console.log(`📂 Database loaded from ${DB_PATH}`);

// Helper: generate the next auto-increment ID for a given table
function nextId(table: keyof DbSchema['_counters']): number {
  data._counters[table] += 1;
  return data._counters[table];
}

// =============================================================
// FRIEND FUNCTIONS
// =============================================================

export function addFriend(spotifyUsername: string, displayName: string): void {
  // Don't add duplicates
  const exists = data.friends.find(f => f.spotify_username === spotifyUsername);
  if (exists) return;

  const friend: Friend = {
    id:               nextId('friends'),
    spotify_username: spotifyUsername,
    display_name:     displayName,
    added_at:         new Date().toISOString(),
  };

  data.friends.push(friend);
  saveData(data);
}

export function getFriends(): Friend[] {
  return data.friends;
}

export function removeFriend(id: number): void {
  // Remove the friend
  data.friends = data.friends.filter(f => f.id !== id);

  // Also remove all their playlists (simulates ON DELETE CASCADE)
  const playlistIds = data.playlists
    .filter(p => p.friend_id === id)
    .map(p => p.id);

  data.playlists       = data.playlists.filter(p => p.friend_id !== id);
  data.playlist_tracks = data.playlist_tracks.filter(
    t => !playlistIds.includes(t.playlist_id)
  );

  saveData(data);
}

// =============================================================
// PLAYLIST FUNCTIONS
// =============================================================

export function getPlaylistsForFriend(friendId: number): Playlist[] {
  return data.playlists.filter(p => p.friend_id === friendId);
}

// Upsert = Insert if new, Update name+timestamp if exists
export function upsertPlaylist(
  friendId: number,
  spotifyPlaylistId: string,
  name: string
): Playlist {
  const existing = data.playlists.find(
    p => p.spotify_playlist_id === spotifyPlaylistId
  );

  if (existing) {
    // Update in place
    existing.name           = name;
    existing.last_polled_at = new Date().toISOString();
    saveData(data);
    return existing;
  }

  // Insert new
  const playlist: Playlist = {
    id:                  nextId('playlists'),
    friend_id:           friendId,
    spotify_playlist_id: spotifyPlaylistId,
    name,
    last_polled_at:      new Date().toISOString(),
  };

  data.playlists.push(playlist);
  saveData(data);
  return playlist;
}

export function deletePlaylist(spotifyPlaylistId: string): void {
  const playlist = data.playlists.find(
    p => p.spotify_playlist_id === spotifyPlaylistId
  );
  if (!playlist) return;

  // Remove the playlist and all its tracks
  data.playlists       = data.playlists.filter(
    p => p.spotify_playlist_id !== spotifyPlaylistId
  );
  data.playlist_tracks = data.playlist_tracks.filter(
    t => t.playlist_id !== playlist.id
  );

  saveData(data);
}

// =============================================================
// TRACK FUNCTIONS
// =============================================================

export function getTracksForPlaylist(playlistId: number): PlaylistTrack[] {
  return data.playlist_tracks.filter(t => t.playlist_id === playlistId);
}

// Replace ALL tracks for a playlist atomically
// (delete old ones, insert new ones in one go)
export function replacePlaylistTracks(
  playlistId: number,
  tracks: { id: string; name: string; artist: string }[]
): void {
  // Remove old tracks for this playlist
  data.playlist_tracks = data.playlist_tracks.filter(
    t => t.playlist_id !== playlistId
  );

  // Insert new tracks
  for (const track of tracks) {
    // Avoid duplicates (same track can appear twice in a playlist)
    const alreadyExists = data.playlist_tracks.find(
      t => t.playlist_id === playlistId && t.spotify_track_id === track.id
    );
    if (!alreadyExists) {
      data.playlist_tracks.push({
        playlist_id:      playlistId,
        spotify_track_id: track.id,
        track_name:       track.name,
        artist_name:      track.artist,
      });
    }
  }

  saveData(data);
}

// =============================================================
// NOTIFICATION FUNCTIONS
// =============================================================

export function addNotification(params: {
  friendId:          number;
  playlistSpotifyId: string;
  playlistName:      string;
  type:              Notification['type'];
  trackName?:        string;
  artistName?:       string;
  extraData?:        object;
}): void {
  const notification: Notification = {
    id:                  nextId('notifications'),
    friend_id:           params.friendId,
    playlist_spotify_id: params.playlistSpotifyId,
    playlist_name:       params.playlistName,
    type:                params.type,
    track_name:          params.trackName  ?? null,
    artist_name:         params.artistName ?? null,
    extra_data:          params.extraData  ? JSON.stringify(params.extraData) : null,
    is_read:             0,
    created_at:          new Date().toISOString(),
  };

  data.notifications.push(notification);
  saveData(data);
}

// Get recent notifications with friend info attached, newest first
export function getNotifications(limit = 50) {
  // Sort by created_at descending (newest first), then take the first `limit`
  const sorted = [...data.notifications].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return sorted.slice(0, limit).map(n => {
    const friend = data.friends.find(f => f.id === n.friend_id);
    return {
      ...n,
      friend_display_name: friend?.display_name ?? 'Unknown',
      friend_username:     friend?.spotify_username ?? 'unknown',
    };
  });
}

export function getUnreadCount(): number {
  return data.notifications.filter(n => n.is_read === 0).length;
}

export function markAsRead(notificationId: number): void {
  const n = data.notifications.find(n => n.id === notificationId);
  if (n) {
    n.is_read = 1;
    saveData(data);
  }
}

export function markAllAsRead(): void {
  data.notifications.forEach(n => { n.is_read = 1; });
  saveData(data);
}

// =============================================================
// RATE LIMIT PERSISTENCE
// Storing this in the JSON file means server restarts won't
// forget that Spotify banned us and immediately re-trigger the ban.
// =============================================================

export function getRateLimitedUntil(): number {
  // If the existing data file predates this field, default to 0 (not limited)
  return data._rateLimitedUntil ?? 0;
}

export function setRateLimitedUntil(timestamp: number): void {
  data._rateLimitedUntil = timestamp;
  saveData(data);
}
