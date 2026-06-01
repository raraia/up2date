// =============================================================
// differ.ts — Change detection ("diffing") logic
// =============================================================
// Given a friend, checks each of their STORED playlists for changes.
//
// Previously this auto-discovered all playlists by Spotify username,
// but Spotify's 2024 API changes blocked that endpoint for third-party
// apps. Now playlists are added manually by URL, and this file just
// monitors the ones already in the database.
//
// What it still detects:
//   - Tracks added to a playlist
//   - Tracks removed from a playlist
//   - Playlist renamed
// =============================================================

import * as db from './db';
import { getPlaylist, getPlaylistTracks } from './spotify';

export async function checkFriendForChanges(friend: {
  id: number;
  spotify_username: string;
  display_name: string;
}): Promise<number> {
  const label = friend.display_name || friend.spotify_username;
  console.log(`  🔍 Checking ${label}...`);

  const storedPlaylists = db.getPlaylistsForFriend(friend.id);

  if (storedPlaylists.length === 0) {
    console.log(`    ℹ️  No playlists tracked for ${label}`);
    return 0;
  }

  let newNotifications = 0;

  for (const stored of storedPlaylists) {
    try {
      // ── Fetch current playlist metadata from Spotify ────────
      // This lets us detect renames and confirm the playlist still exists.
      const current = await getPlaylist(stored.spotify_playlist_id);

      if (!current) {
        // Playlist was deleted or made private — skip quietly
        console.log(`    ⚠️  "${stored.name}" not found — skipping`);
        continue;
      }

      // ── Detect RENAME ───────────────────────────────────────
      if (current.name !== stored.name) {
        console.log(`    ✏️  Renamed: "${stored.name}" → "${current.name}"`);
        db.addNotification({
          friendId:          friend.id,
          playlistSpotifyId: stored.spotify_playlist_id,
          playlistName:      current.name,
          type:              'playlist_renamed',
          extraData:         { oldName: stored.name },
        });
        db.upsertPlaylist(friend.id, stored.spotify_playlist_id, current.name);
        newNotifications++;
      }

      // ── Fetch current tracks and diff against stored ────────
      const currentTracks = await getPlaylistTracks(stored.spotify_playlist_id);
      const savedTracks   = db.getTracksForPlaylist(stored.id);

      const currentIds      = new Set(currentTracks.map(t => t.id));
      const savedIds        = new Set(savedTracks.map(t => t.spotify_track_id));
      const currentTrackMap = new Map(currentTracks.map(t => [t.id, t]));

      // Tracks in Spotify NOW but NOT in our snapshot = ADDED
      for (const id of currentIds) {
        if (!savedIds.has(id)) {
          const track = currentTrackMap.get(id)!;
          console.log(`    ➕ Added to "${current.name}": ${track.name}`);

          const albumArt = (track.album?.images[1] ?? track.album?.images[0])?.url;

          db.addNotification({
            friendId:          friend.id,
            playlistSpotifyId: stored.spotify_playlist_id,
            playlistName:      current.name,
            type:              'track_added',
            trackName:         track.name,
            artistName:        track.artists[0]?.name ?? 'Unknown Artist',
            extraData:         { trackId: track.id, albumId: track.album?.id, ...(albumArt ? { albumArt } : {}) },
          });
          newNotifications++;
        }
      }

      // Tracks in our snapshot but NOT on Spotify anymore = REMOVED
      for (const savedTrack of savedTracks) {
        if (!currentIds.has(savedTrack.spotify_track_id)) {
          console.log(`    ➖ Removed from "${current.name}": ${savedTrack.track_name}`);

          db.addNotification({
            friendId:          friend.id,
            playlistSpotifyId: stored.spotify_playlist_id,
            playlistName:      current.name,
            type:              'track_removed',
            trackName:         savedTrack.track_name,
            artistName:        savedTrack.artist_name,
          });
          newNotifications++;
        }
      }

      // Save the fresh snapshot for next poll
      db.replacePlaylistTracks(
        stored.id,
        currentTracks.map(t => ({
          id:     t.id,
          name:   t.name,
          artist: t.artists[0]?.name ?? 'Unknown Artist',
        }))
      );

      // Refresh last_polled_at
      db.upsertPlaylist(friend.id, stored.spotify_playlist_id, current.name);

    } catch (err) {
      if (err instanceof Error && 'retryAfter' in err) throw err;
      if (err instanceof Error && err.message === 'NOT_CONNECTED') throw err;
      console.error(`    ⚠️  Error checking "${stored.name}":`, err);
    }
  }

  return newNotifications;
}
