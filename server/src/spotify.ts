// =============================================================
// spotify.ts — Spotify API client
// =============================================================
// Auth strategy (updated June 2026):
//
//   Spotify's 2024 API policy change requires OAuth (user login) to
//   access playlist tracks. Client Credentials alone return 403.
//
//   getToken() now prefers the stored OAuth token. If it's expired,
//   it automatically refreshes using the refresh token. Falls back to
//   Client Credentials only for endpoints that don't need user auth.
//
//   To connect: user clicks "Connect Spotify" in the UI once.
//   The refresh token lasts indefinitely (until revoked), so it's
//   a one-time setup.
// =============================================================

import dotenv from 'dotenv';
import * as db from './db';
dotenv.config();

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;
const REDIRECT_URI  = 'https://localhost:3001/callback';

// =============================================================
// TOKEN MANAGEMENT
// =============================================================

// Build the URL the user visits to log in with Spotify
export function getAuthUrl(): string {
  const scopes = [
    'playlist-read-private',
    'playlist-read-collaborative',
  ].join(' ');

  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    response_type: 'code',
    redirect_uri:  REDIRECT_URI,
    scope:         scopes,
  });

  return `https://accounts.spotify.com/authorize?${params}`;
}

// Exchange the one-time code (from the OAuth redirect) for real tokens
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const tokens = await response.json() as {
    access_token:  string;
    refresh_token: string;
    expires_in:    number;
  };

  db.setSpotifyAuth({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    Date.now() + (tokens.expires_in - 300) * 1000,
  });

  console.log('✅ Spotify OAuth connected — tokens saved');
}

// Use the stored refresh token to get a fresh access token
async function refreshOAuthToken(): Promise<string> {
  const auth = db.getSpotifyAuth();
  if (!auth) throw new Error('No OAuth tokens stored');

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: auth.refresh_token,
    }).toString(),
  });

  if (!response.ok) {
    db.clearSpotifyAuth(); // refresh token is dead — user needs to reconnect
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const tokens = await response.json() as {
    access_token:  string;
    refresh_token?: string; // Spotify sometimes rotates the refresh token
    expires_in:    number;
  };

  db.setSpotifyAuth({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token ?? auth.refresh_token,
    expires_at:    Date.now() + (tokens.expires_in - 300) * 1000,
  });

  console.log('🔑 OAuth token refreshed');
  return tokens.access_token;
}

// getToken — the single function all API calls use.
// Prefers the stored OAuth token, auto-refreshes if expired.
async function getToken(): Promise<string> {
  const auth = db.getSpotifyAuth();

  if (auth) {
    // Token still valid — use it
    if (Date.now() < auth.expires_at) return auth.access_token;
    // Expired — refresh and return fresh one
    return refreshOAuthToken();
  }

  // No OAuth token — user hasn't connected yet.
  // Throw a clear error instead of silently using Client Credentials
  // (which would just return 403 on protected endpoints anyway).
  throw new Error('NOT_CONNECTED');
}

// =============================================================
// TYPE DEFINITIONS
// =============================================================
// TypeScript uses these "interfaces" to know the shape of API responses.
// This helps catch bugs — if Spotify changes their API, TypeScript will warn us.

export interface SpotifyPlaylist {
  id: string;
  name: string;
  public: boolean;
  owner: { id: string; display_name: string };
  tracks: { total: number };
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: { name: string }[];
  // Album art comes as an array of images at different sizes.
  // Spotify typically gives: 640px, 300px, 64px — we'll grab the 300px one.
  album: {
    id: string;
    images: { url: string; width: number; height: number }[];
  };
}

// =============================================================
// API FUNCTIONS
// =============================================================

/**
 * Fetch all PUBLIC playlists owned by a Spotify user.
 *
 * Spotify's API paginates results — it returns max 50 at a time,
 * with a "next" URL to get the next page. We loop until next is null.
 */
export async function getUserPlaylists(userId: string): Promise<SpotifyPlaylist[]> {
  const token = await getToken();
  const playlists: SpotifyPlaylist[] = [];

  // Start with the first page
  let url: string | null =
    `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists?limit=50`;

  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 429) {
      // Spotify rate limit hit. The Retry-After header tells us exactly how many
      // seconds to wait before trying again. We throw a special error so the
      // poller can read the wait time and pause itself accordingly.
      const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10);
      const err = new Error(`Rate limited`) as Error & { retryAfter: number };
      err.retryAfter = retryAfter;
      throw err;
    }

    if (!response.ok) {
      throw new Error(`Spotify API error ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as {
      items: SpotifyPlaylist[];
      next: string | null; // URL to the next page, or null if this is the last
    };

    // Only keep playlists that are:
    //  - public (we can't see private ones anyway)
    //  - actually owned by this user (collaborative playlists show up here too)
    const ownedPublic = data.items.filter(
      (p) => p.public && p.owner.id === userId
    );
    playlists.push(...ownedPublic);

    url = data.next; // null when we've fetched all pages
  }

  return playlists;
}

/**
 * Fetch all tracks in a given playlist.
 * Also paginated — max 100 tracks per page.
 *
 * The `fields` parameter tells Spotify to only send us the fields we need
 * (saves bandwidth — some playlists have a LOT of data per track otherwise).
 */
export async function getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
  const token = await getToken();
  const tracks: SpotifyTrack[] = [];

  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks` +
    `?limit=100&fields=next,items(track(id,name,artists(name),album(id,images)))`;

  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 429) {
      // Same rate limit handling as getUserPlaylists — throw a special error
      // so the poller can store the cooldown and skip future polls.
      const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10);
      const err = new Error('Rate limited') as Error & { retryAfter: number };
      err.retryAfter = retryAfter;
      throw err;
    }

    if (!response.ok) {
      throw new Error(`Spotify track fetch error ${response.status}`);
    }

    const data = await response.json() as {
      // Each item has a "track" object — which can be null if the track
      // was removed from Spotify entirely (e.g., label pulled it)
      items: { track: SpotifyTrack | null }[];
      next: string | null;
    };

    // Filter out null tracks and tracks without an ID
    const valid = data.items
      .map((item) => item.track)
      .filter((t): t is SpotifyTrack => t !== null && Boolean(t.id));

    tracks.push(...valid);
    url = data.next;
  }

  return tracks;
}

/**
 * Fetch a single playlist by its Spotify ID.
 * Returns null if the playlist doesn't exist or is private.
 * Used when adding a playlist to track, and during polling to detect renames.
 */
export async function getPlaylist(
  playlistId: string
): Promise<{ id: string; name: string; owner: { id: string; display_name: string } } | null> {
  const token = await getToken();
  const response = await fetch(
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}?fields=id,name,owner(id,display_name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Spotify playlist fetch error ${response.status}`);
  return response.json() as Promise<{ id: string; name: string; owner: { id: string; display_name: string } }>;
}

/**
 * Look up a Spotify user by their username/ID.
 * Returns null if the user doesn't exist (404).
 * Used to validate a friend before we start tracking them.
 */
export async function getUserProfile(
  userId: string
): Promise<{ id: string; display_name: string } | null> {
  const token = await getToken();

  const response = await fetch(
    `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (response.status === 404) return null; // User doesn't exist
  if (!response.ok) throw new Error(`Spotify user fetch error ${response.status}`);

  return response.json() as Promise<{ id: string; display_name: string }>;
}
