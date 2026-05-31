// =============================================================
// index.ts — Express server entry point
// =============================================================
// This is the "front door" of the backend. It:
//   - Creates an HTTP server using Express
//   - Defines all the API endpoints (routes) the frontend can call
//   - Starts the background poller
//
// An "API endpoint" is just a URL your frontend can fetch.
// Example: GET http://localhost:3001/api/notifications
//          → returns a JSON list of notifications
//
// REST API conventions we follow:
//   GET    → read data        (safe, no side effects)
//   POST   → create something
//   PATCH  → update something
//   DELETE → remove something
// =============================================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as db from './db';
import { getPlaylist, getPlaylistTracks } from './spotify';
import { startPoller, registerSSEClient, runPollCycle } from './poller';

// Load .env file into process.env
// Must happen before any code tries to read process.env.SPOTIFY_*
dotenv.config();

const app  = express();
const PORT = process.env.PORT ?? 3001;

// =============================================================
// MIDDLEWARE
// Middleware = functions that run on EVERY request before your
// route handlers. Think of them as a pipeline each request flows through.
// =============================================================

// CORS = Cross-Origin Resource Sharing
// Without this, browsers block requests from one origin (localhost:5173 = frontend)
// to a different origin (localhost:3001 = backend). This header tells the browser it's okay.
app.use(cors({
  origin: 'http://localhost:5173', // Vite's default dev server port
  credentials: true,
}));

// Parse incoming JSON request bodies so we can read req.body
app.use(express.json());

// =============================================================
// SSE ENDPOINT — Real-time updates
// GET /api/events
//
// The browser connects here once and keeps the connection open.
// When the poller finds new changes, it pushes a message down this pipe.
// The frontend listens for those messages to know when to refresh.
// =============================================================
app.get('/api/events', (req, res) => {
  // These headers tell the browser: "this is a streaming response, don't close it"
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');

  // Send an initial heartbeat so the frontend knows the connection is alive
  res.write('event: connected\ndata: {"message":"Connected to Up2Date"}\n\n');

  // Register this browser as an SSE listener.
  // We pass a function that writes to THIS response object.
  const unsubscribe = registerSSEClient((data) => res.write(data));

  // When the browser closes the tab / navigates away, clean up
  req.on('close', unsubscribe);
});

// =============================================================
// FRIENDS ENDPOINTS
// =============================================================

// GET /api/friends → list all tracked friends
app.get('/api/friends', (_req, res) => {
  res.json(db.getFriends());
});

// POST /api/playlists → start tracking a playlist by Spotify URL or ID
// Body: { "input": "https://open.spotify.com/playlist/..." }  or just the ID
app.post('/api/playlists', async (req, res) => {
  const { input } = req.body as { input?: string };

  if (!input?.trim()) {
    res.status(400).json({ error: 'Playlist URL or ID is required' });
    return;
  }

  // Pull the playlist ID out of a full Spotify URL, or use the raw string if
  // the user already pasted just the ID.
  // URL format: https://open.spotify.com/playlist/<id>?si=...
  const match = input.trim().match(/playlist[/:]([A-Za-z0-9]+)/);
  const playlistId = match ? match[1] : input.trim();

  let playlist;
  try {
    playlist = await getPlaylist(playlistId);
  } catch (err) {
    res.status(500).json({ error: 'Could not reach Spotify API' });
    return;
  }

  if (!playlist) {
    res.status(404).json({ error: 'Playlist not found — make sure it\'s public' });
    return;
  }

  // Group playlists under the owner as a "friend" so notifications still say
  // who made the change. Create the friend record if we haven't seen this owner before.
  const friends = db.getFriends();
  let friend = friends.find(f => f.spotify_username === playlist.owner.id);
  if (!friend) {
    db.addFriend(playlist.owner.id, playlist.owner.display_name || playlist.owner.id);
    friend = db.getFriends().find(f => f.spotify_username === playlist.owner.id)!;
  }

  // Save the playlist and take an initial track snapshot.
  // No notifications for the first snapshot — we only notify on *changes* from here on.
  const stored = db.upsertPlaylist(friend.id, playlist.id, playlist.name);
  const tracks  = await getPlaylistTracks(playlist.id);
  db.replacePlaylistTracks(stored.id, tracks.map(t => ({
    id:     t.id,
    name:   t.name,
    artist: t.artists[0]?.name ?? 'Unknown Artist',
  })));

  res.json({ success: true, name: playlist.name, owner: playlist.owner.display_name });
});

// GET /api/playlists → list all tracked playlists with their owner info
app.get('/api/playlists', (_req, res) => {
  const friends = db.getFriends();
  const result = friends.flatMap(friend =>
    db.getPlaylistsForFriend(friend.id).map(p => ({
      spotify_playlist_id: p.spotify_playlist_id,
      name:                p.name,
      owner_name:          friend.display_name || friend.spotify_username,
      last_polled_at:      p.last_polled_at,
    }))
  );
  res.json(result);
});

// DELETE /api/playlists/:spotifyId → stop tracking a specific playlist
app.delete('/api/playlists/:spotifyId', (req, res) => {
  db.deletePlaylist(req.params.spotifyId);
  res.json({ success: true });
});

// DELETE /api/friends/:id → stop tracking a friend
app.delete('/api/friends/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  db.removeFriend(id);
  res.json({ success: true });
});

// =============================================================
// NOTIFICATION ENDPOINTS
// =============================================================

// GET /api/notifications → get recent notifications (newest first)
app.get('/api/notifications', (_req, res) => {
  res.json(db.getNotifications(50));
});

// GET /api/notifications/unread-count → just the badge number
app.get('/api/notifications/unread-count', (_req, res) => {
  res.json({ count: db.getUnreadCount() });
});

// PATCH /api/notifications/:id/read → mark one notification as read
app.patch('/api/notifications/:id/read', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.markAsRead(id);
  res.json({ success: true });
});

// BUTTON !! 
// POST /api/poll -> trigger an immediate poll cycle

app.post('/api/poll', async (_req, res) => {
  await runPollCycle()
  res.json ({success: true})
})

// POST /api/notifications/mark-all-read → mark everything as read
app.post('/api/notifications/mark-all-read', (_req, res) => {
  db.markAllAsRead();
  res.json({ success: true });
});

// =============================================================
// START THE SERVER
// =============================================================
app.listen(PORT, () => {
  console.log(`\n🎵 Up2Date server running → http://localhost:${PORT}`);
  console.log(`📡 SSE stream          → http://localhost:${PORT}/api/events`);
  console.log(`📋 Notifications API   → http://localhost:${PORT}/api/notifications\n`);

  // Kick off the background polling
  startPoller();
});
