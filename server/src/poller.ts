// =============================================================
// poller.ts — Background polling + SSE broadcasting
// =============================================================
// This file does two jobs:
//
//  1. POLLING: Runs a function every N minutes that checks all
//     tracked friends for Spotify changes.
//
//  2. SSE (Server-Sent Events): Manages a list of browser clients
//     that are listening for real-time updates, and pushes to them
//     whenever the poll finds something new.
//
// SSE is like a one-way phone call: the server talks, the browser
// listens. Simpler than WebSockets because it's built into the browser
// natively and we only need server → browser (not two-way).
// =============================================================

import * as db from './db';
import { checkFriendForChanges } from './differ';

// How often to check Spotify (milliseconds)
// 5 minutes = 5 * 60 * 1000
// Don't set this too low — Spotify has rate limits and we make
// multiple API calls per friend per poll.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

// A Set of "send" functions — one per connected browser tab.
// When a browser connects to GET /api/events, we add its send function here.
// When it disconnects, we remove it.
//
// Using a Set (not an array) so adding/removing is O(1) and we can't have duplicates.
const sseClients = new Set<(data: string) => void>();

// =============================================================
// SSE CLIENT MANAGEMENT
// =============================================================

/**
 * Register a new browser as an SSE listener.
 * Call this when a client connects to GET /api/events.
 * Returns an "unsubscribe" function — call it when the client disconnects.
 */
export function registerSSEClient(send: (data: string) => void): () => void {
  sseClients.add(send);
  console.log(`📡 Browser connected via SSE (${sseClients.size} connected)`);

  return function unsubscribe() {
    sseClients.delete(send);
    console.log(`📡 Browser disconnected (${sseClients.size} remaining)`);
  };
}

/**
 * Push a message to ALL connected browsers.
 * The SSE format requires:
 *   event: <event-name>\n
 *   data: <json string>\n
 *   \n   ← blank line marks end of message
 */
function broadcast(event: string, data: object) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const send of sseClients) {
    try {
      send(message);
    } catch {
      // Client probably disconnected mid-send — clean it up
      sseClients.delete(send);
    }
  }
}

// =============================================================
// POLLING LOGIC
// =============================================================

async function runPollCycle() {
  const friends = db.getFriends();

  if (friends.length === 0) {
    console.log('👀 No friends tracked yet — add one via the UI');
    return;
  }

  console.log(`\n⏰ Poll starting — checking ${friends.length} friend(s)...`);
  let totalNew = 0;

  for (const friend of friends) {
    const count = await checkFriendForChanges(friend);
    totalNew += count;
  }

  console.log(`✅ Poll done — ${totalNew} new notification(s)\n`);

  // If anything changed, tell every connected browser so the UI can refresh
  if (totalNew > 0) {
    broadcast('new-notifications', {
      count:  totalNew,
      unread: db.getUnreadCount(),
    });
  }
}

/**
 * Start the background poller.
 * Runs immediately once (so you see data right away on startup),
 * then repeats on the interval.
 */
export function startPoller() {
  const minutes = POLL_INTERVAL_MS / 1000 / 60;
  console.log(`🚀 Poller started — checking every ${minutes} minutes`);

  // First check immediately on startup
  runPollCycle();

  // Then schedule repeating checks
  setInterval(runPollCycle, POLL_INTERVAL_MS);
}
