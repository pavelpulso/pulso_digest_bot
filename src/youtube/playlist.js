import { getSetting, setSetting } from "../db.js"

const PLAYLIST_ID_KEY = "yt_playlist_id"
const PLAYLIST_TITLE = "Pulso Digest"
const PLAYLIST_DESCRIPTION = "Daily rolling selection from Pulso Digest. Synced automatically — don't edit by hand."

/**
 * Converges the YouTube playlist to today's selection by diff, not by rebuild:
 * playlistItems.insert/delete cost 50 quota units each, so clearing and refilling
 * every night would triple the daily cost for no benefit.
 *
 * @param {object} opts
 * @param {import("./client.js").YouTubeClient} opts.client
 * @param {string[]} opts.picks - selected video ids, best-first. Missing ones get added.
 * @param {Set<string>|string[]} opts.windowVideoIds - video ids still inside the rolling
 *   window. Any playlist entry whose video id is not in this set gets removed.
 */
export async function syncPlaylist({ client, picks, windowVideoIds }) {
  let playlistId = getSetting(PLAYLIST_ID_KEY)
  if (!playlistId) {
    playlistId = await client.createPlaylist(PLAYLIST_TITLE, PLAYLIST_DESCRIPTION)
    setSetting(PLAYLIST_ID_KEY, playlistId)
  }

  const windowSet = windowVideoIds instanceof Set ? windowVideoIds : new Set(windowVideoIds)
  const existing = await client.listPlaylistItemIds(playlistId)
  const existingVideoIds = new Set(existing.map((e) => e.videoId))

  const toAdd = picks.filter((id) => !existingVideoIds.has(id))
  // playlistItems.insert always lands at position 0, so inserting worst-first leaves
  // the best pick sitting on top once all inserts are done.
  for (const videoId of [...toAdd].reverse()) {
    await client.addVideoToPlaylist(playlistId, videoId, 0)
  }

  const toRemove = existing.filter((e) => !windowSet.has(e.videoId))
  for (const item of toRemove) {
    // Removal needs the playlistItem id, not the video id — that's why `existing` keeps both.
    await client.removePlaylistItem(item.playlistItemId)
  }

  return { playlistId, added: toAdd.length, removed: toRemove.length }
}
