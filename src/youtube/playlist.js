import { getSetting, setSetting } from "../db.js"

const PLAYLIST_ID_KEY = "yt_playlist_id"
const PLAYLIST_TITLE = "Pulso Digest"
const PLAYLIST_DESCRIPTION = "Daily rolling selection from Pulso Digest. Synced automatically — don't edit by hand."

// playlistItems.insert/delete cost 50 quota units each (reads cost 1), so this is a backstop
// against the caller's own cap: 60 writes = 3,000 units, enough to fill an empty playlist
// (VIDEO_DAILY_CAP = 30 adds) and still prune a full week in the same run, while leaving
// most of the 10,000/day budget for collection and ranking reads.
const MAX_WRITES_PER_RUN = 60

async function createAndStorePlaylist(client) {
  const id = await client.createPlaylist(PLAYLIST_TITLE, PLAYLIST_DESCRIPTION)
  setSetting(PLAYLIST_ID_KEY, id)
  return id
}

/**
 * Converges the YouTube playlist to today's selection by diff, not by rebuild.
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
    playlistId = await createAndStorePlaylist(client)
  }

  let existing
  try {
    existing = await client.listPlaylistItemIds(playlistId)
  } catch (e) {
    if (e.reason !== "playlistNotFound") throw e
    // The user deleted the playlist by hand: the cached id is dead. Recreate instead of
    // alerting every night for something that fixes itself.
    playlistId = await createAndStorePlaylist(client)
    existing = []
  }

  const windowSet = windowVideoIds instanceof Set ? windowVideoIds : new Set(windowVideoIds)
  const existingVideoIds = new Set(existing.map((e) => e.videoId))

  const toAdd = picks.filter((id) => !existingVideoIds.has(id))
  const toRemove = existing.filter((e) => !windowSet.has(e.videoId))

  // Adds are served first out of the shared write budget: a deferred removal just leaves
  // a stale entry for one more day, while a deferred add is the thing the user wants to see.
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

  return {
    playlistId,
    added: toAddAllowed.length,
    removed: toRemoveAllowed.length,
    skippedAdds: toAdd.length - toAddAllowed.length,
    skippedRemoves: toRemove.length - toRemoveAllowed.length
  }
}
