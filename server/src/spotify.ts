// =============================================================
// spotify.ts — Spotify API client
// =============================================================
// This file handles all communication with Spotify's Web API.
//
// HOW AUTH WORKS HERE (Client Credentials Flow):
//   1. We send our Client ID + Secret to Spotify
//   2. Spotify gives us a temporary "access token" (like a session key)
//   3. We attach that token to every API request
//   4. Tokens expire after 1 hour — we auto-refresh when needed
//
// We CAN access: any public playlist, any public user profile
// We CANNOT access: private playlists, user listening history, etc.
// That's fine — we just need public playlists!
// =============================================================

import dotenv from 'dotenv';
dotenv.config();

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;

// Token cache — we store the token in memory so we're not hitting
// Spotify's auth endpoint on every single API call.
let cachedToken: string | null = null;
let tokenExpiresAt: number = 0; // Unix timestamp (milliseconds)

// =============================================================
// TOKEN MANAGEMENT
// =============================================================

async function getToken(): Promise<string> {
  const now = Date.now();

  // If we have a valid cached token, reuse it
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  // Otherwise, request a new one.
  // Spotify requires the credentials as: Base64("clientId:clientSecret")
  // Buffer.from(...).toString('base64') is Node's built-in way to do base64
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    // The body must be URL-encoded form data (not JSON) — Spotify's requirement
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(
      `Failed to get Spotify token: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json() as {
    access_token: string;
    expires_in: number; // seconds until expiry (usually 3600 = 1 hour)
  };

  cachedToken = data.access_token;
  // Subtract 5 minutes as a safety buffer — refresh a bit before actual expiry
  tokenExpiresAt = now + (data.expires_in - 300) * 1000;

  console.log('🔑 Got new Spotify access token (valid for 1 hour)');
  return cachedToken;
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
