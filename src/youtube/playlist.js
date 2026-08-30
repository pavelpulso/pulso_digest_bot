import { getSetting, setSetting } from "../db.js"
import { PLAYLIST_SIZE } from "../services/BotService.js"

const PLAYLIST_ID_KEY = "yt_playlist_id"
const PLAYLIST_TITLE = "Pulso Digest"
const PLAYLIST_DESCRIPTION = "Daily rolling selection from Pulso Digest. Synced automatically — don't edit by hand."

const MAX_WRITES_PER_RUN = 60

async function createAndStorePlaylist(client) {
  const id = await client.createPlaylist(PLAYLIST_TITLE, PLAYLIST_DESCRIPTION)
  setSetting(PLAYLIST_ID_KEY, id)
  return id
}

/**
 * Converges the YouTube playlist to a fixed-size showcase of the current best, by diff,
 * not by accumulation.
 *
 * @param {object} opts
 * @param {import("./client.js").YouTubeClient} opts.client
 * @param {string[]} opts.ranked - candidate video ids still inside the rolling window,
 *   best score first. The top PLAYLIST_SIZE form the target the playlist converges to.
 * @param {number} [opts.maxWrites] - ceiling on inserts+deletes issued this run.
 */
export async function syncPlaylist({ client, ranked, maxWrites = MAX_WRITES_PER_RUN }) {
  let playlistId = getSetting(PLAYLIST_ID_KEY)
  if (!playlistId) {
    playlistId = await createAndStorePlaylist(client)
  }

  let existing
  try {
    existing = await client.listPlaylistItemIds(playlistId)
  } catch (e) {
    if (e.reason !== "playlistNotFound") throw e
    playlistId = await createAndStorePlaylist(client)
    existing = []
  }

  const target = ranked.slice(0, PLAYLIST_SIZE)
  const targetSet = new Set(target)
  const existingVideoIds = new Set(existing.map((e) => e.videoId))

  const toAdd = target.filter((id) => !existingVideoIds.has(id))
  const toRemove = existing.filter((e) => !targetSet.has(e.videoId))

  const addBudget = Math.min(toAdd.length, maxWrites)
  const toAddAllowed = toAdd.slice(0, addBudget)
  for (const videoId of [...toAddAllowed].reverse()) {
    await client.addVideoToPlaylist(playlistId, videoId, 0)
  }

  const removeBudget = Math.max(0, maxWrites - addBudget)
  const toRemoveAllowed = toRemove.slice(0, removeBudget)
  for (const item of toRemoveAllowed) {
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
