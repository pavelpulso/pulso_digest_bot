import { getSetting, setSetting } from "../db.js"

const PLAYLIST_ID_KEY = "yt_playlist_id"
const PLAYLIST_TITLE = "Pulso Digest"
const PLAYLIST_DESCRIPTION = "Daily rolling selection from Pulso Digest. Synced automatically — don't edit by hand."

/**
 * Hard ceiling on writes (inserts + removals combined) per run. playlistItems.insert/delete
 * cost 50 quota units each, so 60 writes is 3,000 units — enough to fill an empty playlist
 * from scratch (up to VIDEO_DAILY_CAP = 30 adds) and still prune a full week's worth in the
 * same run, while leaving most of the 10,000/day budget for collection and ranking reads.
 * This is a backstop: a caller that miscounts and hands syncPlaylist hundreds of picks (as
 * happened when `picks` briefly held every ranked video instead of the daily selection)
 * must not be able to burn the day's quota — it hits this wall and reports what it skipped.
 */
const MAX_WRITES_PER_RUN = 60

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
 * @param {number} [opts.maxWrites] - ceiling on inserts+deletes issued this run.
 */
export async function syncPlaylist({ client, picks, windowVideoIds, maxWrites = MAX_WRITES_PER_RUN }) {
  let playlistId = getSetting(PLAYLIST_ID_KEY)
  if (!playlistId) {
    playlistId = await client.createPlaylist(PLAYLIST_TITLE, PLAYLIST_DESCRIPTION)
    setSetting(PLAYLIST_ID_KEY, playlistId)
  }

  const windowSet = windowVideoIds instanceof Set ? windowVideoIds : new Set(windowVideoIds)
  const existing = await client.listPlaylistItemIds(playlistId)
  const existingVideoIds = new Set(existing.map((e) => e.videoId))

  const toAdd = picks.filter((id) => !existingVideoIds.has(id))
  const toRemove = existing.filter((e) => !windowSet.has(e.videoId))

  // Adds come first out of the shared budget: they're this run's fresh selection, while a
  // removal that gets deferred just means a stale entry survives one more day, unharmed.
  const addBudget = Math.min(toAdd.length, maxWrites)
  const toAddAllowed = toAdd.slice(0, addBudget)
  // playlistItems.insert always lands at position 0, so inserting worst-first leaves
  // the best pick sitting on top once all inserts are done.
  for (const videoId of [...toAddAllowed].reverse()) {
    await client.addVideoToPlaylist(playlistId, videoId, 0)
  }

  const removeBudget = Math.max(0, maxWrites - addBudget)
  const toRemoveAllowed = toRemove.slice(0, removeBudget)
  for (const item of toRemoveAllowed) {
    // Removal needs the playlistItem id, not the video id — that's why `existing` keeps both.
    await client.removePlaylistItem(item.playlistItemId)
  }

  const skippedAdds = toAdd.length - toAddAllowed.length
  const skippedRemoves = toRemove.length - toRemoveAllowed.length

  return {
    playlistId,
    added: toAddAllowed.length,
    removed: toRemoveAllowed.length,
    skippedAdds,
    skippedRemoves
  }
}
