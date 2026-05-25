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
import { getUserProfile } from './spotify';
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

// POST /api/friends → add a new friend to track
// Body: { "spotifyUsername": "their_spotify_id" }
app.post('/api/friends', async (req, res) => {
  const { spotifyUsername } = req.body as { spotifyUsername?: string };

  if (!spotifyUsername?.trim()) {
    res.status(400).json({ error: 'spotifyUsername is required' });
    return;
  }

  // Validate the user exists on Spotify before we start tracking them
  let profile;
  try {
    profile = await getUserProfile(spotifyUsername.trim());
  } catch (err) {
    res.status(500).json({ error: 'Could not reach Spotify API' });
    return;
  }

  if (!profile) {
    res.status(404).json({ error: `Spotify user "${spotifyUsername}" not found` });
    return;
  }

  db.addFriend(profile.id, profile.display_name);
  res.json({ success: true, friend: profile });
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
