// =============================================================
// differ.ts — Change detection ("diffing") logic
// =============================================================
// This is the brain of the app. Given a friend, it:
//   1. Asks Spotify: "what playlists/tracks do they have RIGHT NOW?"
//   2. Asks our database: "what did we save LAST TIME we checked?"
//   3. Compares the two and generates notifications for any differences.
//
// This is essentially a manual "git diff" for Spotify playlists.
// =============================================================

import * as db from './db';
import { getUserPlaylists, getPlaylistTracks } from './spotify';

/**
 * Check a single friend for any playlist changes since the last poll.
 * Creates notifications in the database for anything that changed.
 * Returns the number of new notifications created.
 */
export async function checkFriendForChanges(friend: {
  id: number;
  spotify_username: string;
  display_name: string;
}): Promise<number> {
  const label = friend.display_name || friend.spotify_username;
  console.log(`  🔍 Checking ${label}...`);

  let newNotifications = 0;

  // ── Step 1: Fetch current state from Spotify ──────────────────
  let spotifyPlaylists;
  try {
    spotifyPlaylists = await getUserPlaylists(friend.spotify_username);
  } catch (err) {
    // If Spotify rate-limited us, re-throw so the poller can handle the backoff.
    // For any other error, just log and skip this friend quietly.
    if (err instanceof Error && 'retryAfter' in err) throw err;
    console.error(`  ⚠️  Could not fetch playlists for ${label}:`, err);
    return 0;
  }

  // ── Step 2: Get what we saved in the database last time ───────
  const savedPlaylists = db.getPlaylistsForFriend(friend.id);

  // Convert both lists to Maps keyed by Spotify playlist ID.
  // Maps give us O(1) lookups — much faster than searching an array.
  const spotifyMap = new Map(spotifyPlaylists.map((p) => [p.id, p]));
  const savedMap   = new Map(savedPlaylists.map((p) => [p.spotify_playlist_id, p]));

  // ── Step 3: Detect DELETED playlists ─────────────────────────
  // A playlist is "deleted" if it's in our DB but NOT in the Spotify response.
  for (const saved of savedPlaylists) {
    if (!spotifyMap.has(saved.spotify_playlist_id)) {
      console.log(`    ❌ Playlist deleted: "${saved.name}"`);

      db.addNotification({
        friendId:           friend.id,
        playlistSpotifyId:  saved.spotify_playlist_id,
        playlistName:       saved.name,
        type:               'playlist_deleted',
      });

      // Remove it from our database too — no point keeping the snapshot
      db.deletePlaylist(saved.spotify_playlist_id);
      newNotifications++;
    }
  }

  // ── Step 4: Check each playlist currently on Spotify ─────────
  for (const spotifyPlaylist of spotifyPlaylists) {
    const saved = savedMap.get(spotifyPlaylist.id);

    // ── 4a: NEW playlist (not in our DB at all) ───────────────
    if (!saved) {
      console.log(`    ✨ New playlist: "${spotifyPlaylist.name}"`);

      // Save it to the database
      const newRow = db.upsertPlaylist(friend.id, spotifyPlaylist.id, spotifyPlaylist.name);

      // Fetch its tracks and save them as the initial snapshot
      // (we don't fire track_added notifications for the initial snapshot —
      // that would spam you when you first add a friend with 500-song playlists)
      const tracks = await getPlaylistTracks(spotifyPlaylist.id);
      db.replacePlaylistTracks(
        newRow.id,
        tracks.map((t) => ({
          id:     t.id,
          name:   t.name,
          artist: t.artists[0]?.name ?? 'Unknown Artist',
        }))
      );

      db.addNotification({
        friendId:          friend.id,
        playlistSpotifyId: spotifyPlaylist.id,
        playlistName:      spotifyPlaylist.name,
        type:              'playlist_created',
      });

      newNotifications++;
      continue; // Skip to next playlist — no further checks needed for new ones
    }

    // ── 4b: Existing playlist — check for changes ─────────────

    // Check for RENAME
    if (saved.name !== spotifyPlaylist.name) {
      console.log(`    ✏️  Renamed: "${saved.name}" → "${spotifyPlaylist.name}"`);

      db.addNotification({
        friendId:          friend.id,
        playlistSpotifyId: spotifyPlaylist.id,
        playlistName:      spotifyPlaylist.name,
        type:              'playlist_renamed',
        extraData:         { oldName: saved.name }, // store old name for display
      });

      // Update the stored name
      db.upsertPlaylist(friend.id, spotifyPlaylist.id, spotifyPlaylist.name);
      newNotifications++;
    }

    // Check for TRACK CHANGES
    // Fetch the current track list from Spotify
    const currentTracks = await getPlaylistTracks(spotifyPlaylist.id);
    // Get our saved snapshot from the database
    const savedTracks   = db.getTracksForPlaylist(saved.id);

    // Build Sets of IDs — Sets make it easy to do "is X in the other list?" checks
    const currentIds = new Set(currentTracks.map((t) => t.id));
    const savedIds   = new Set(savedTracks.map((t) => t.spotify_track_id));

    // Build a Map so we can look up track details by ID
    const currentTrackMap = new Map(currentTracks.map((t) => [t.id, t]));

    // Tracks in Spotify NOW but NOT in our saved snapshot = ADDED
    for (const id of currentIds) {
      if (!savedIds.has(id)) {
        const track = currentTrackMap.get(id)!;
        console.log(`    ➕ Added to "${spotifyPlaylist.name}": ${track.name}`);

        // Pick the medium-size album image (index 1 = ~300px).
        // Falls back to the first available image, or undefined if none.
        const albumArt = (track.album?.images[1] ?? track.album?.images[0])?.url;

        db.addNotification({
          friendId:          friend.id,
          playlistSpotifyId: spotifyPlaylist.id,
          playlistName:      spotifyPlaylist.name,
          type:              'track_added',
          trackName:         track.name,
          artistName:        track.artists[0]?.name ?? 'Unknown Artist',
          // Store album art URL + track ID so the frontend can show art
          // and link directly to the song on Spotify
          extraData:         { trackId: track.id, albumId: track.album?.id, ...(albumArt ? { albumArt } : {}) },
        });

        newNotifications++;
      }
    }

    // Tracks in our snapshot but NOT on Spotify anymore = REMOVED
    for (const savedTrack of savedTracks) {
      if (!currentIds.has(savedTrack.spotify_track_id)) {
        console.log(`    ➖ Removed from "${spotifyPlaylist.name}": ${savedTrack.track_name}`);

        db.addNotification({
          friendId:          friend.id,
          playlistSpotifyId: spotifyPlaylist.id,
          playlistName:      spotifyPlaylist.name,
          type:              'track_removed',
          trackName:         savedTrack.track_name,
          artistName:        savedTrack.artist_name,
        });

        newNotifications++;
      }
    }

    // Update our snapshot to match the current state
    // Next poll, this fresh snapshot becomes the "before" to compare against
    db.replacePlaylistTracks(
      saved.id,
      currentTracks.map((t) => ({
        id:     t.id,
        name:   t.name,
        artist: t.artists[0]?.name ?? 'Unknown Artist',
      }))
    );

    // Refresh the last_polled_at timestamp
    db.upsertPlaylist(friend.id, spotifyPlaylist.id, spotifyPlaylist.name);
  }

  return newNotifications;
}
