import { getSetting, setSetting } from "../db.js"
import { QuotaExceededError } from "./client.js"
import { PLAYLIST_SIZE } from "../services/BotService.js"

const PLAYLIST_ID_KEY = "yt_playlist_id"
export const PLAYLIST_TITLE = "Pulso Digest"
export const PLAYLIST_DESCRIPTION = "Daily rolling selection from Pulso Digest. Synced automatically — don't edit by hand."

const ARCHIVE_ID_KEY = "yt_archive_playlist_id"
export const ARCHIVE_TITLE = "Pulso Digest Archive"
export const ARCHIVE_DESCRIPTION = "Everything Pulso Digest has ever surfaced, oldest first. Append-only — don't edit by hand."

const SHOWCASE = { key: PLAYLIST_ID_KEY, title: PLAYLIST_TITLE, description: PLAYLIST_DESCRIPTION }
const ARCHIVE = { key: ARCHIVE_ID_KEY, title: ARCHIVE_TITLE, description: ARCHIVE_DESCRIPTION }

const MAX_WRITES_PER_RUN = 60
const MAX_ARCHIVE_WRITES_PER_RUN = 30

async function createAndStorePlaylist(client, playlist) {
  const id = await client.createPlaylist(playlist.title, playlist.description)
  setSetting(playlist.key, id)
  return id
}

/** A missing stored id doesn't mean the account has no playlist — a restored DB, a new
 * host, or a working directory with its own empty sqlite file (as happened here) all lose
 * the id while the real playlist lives on. Search before creating so those cases adopt
 * the existing playlist instead of minting a duplicate. */
async function resolvePlaylistId(client, playlist) {
  const found = await client.findPlaylistByTitle(playlist.title, playlist.description)
  if (found) {
    setSetting(playlist.key, found)
    return found
  }
  return createAndStorePlaylist(client, playlist)
}

/** Reads a playlist's current contents, healing the stored id if the playlist it points at
 * is gone (deleted by hand, or an id carried over from another account). */
async function loadPlaylist(client, playlist) {
  let playlistId = getSetting(playlist.key)
  if (!playlistId) {
    playlistId = await resolvePlaylistId(client, playlist)
  }

  try {
    return { playlistId, existing: await client.listPlaylistItemIds(playlistId) }
  } catch (e) {
    if (e.reason !== "playlistNotFound") throw e
    playlistId = await resolvePlaylistId(client, playlist)
    return { playlistId, existing: [] }
  }
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
  // An empty ranking means the ranking failed, not that the day has nothing worth showing:
  // treating it as a target wipes the playlist and leaves nothing to fall back on.
  if (ranked.length === 0) {
    return { playlistId: getSetting(PLAYLIST_ID_KEY), added: 0, removed: 0, size: 0, skippedAdds: 0, skippedRemoves: 0 }
  }

  const { playlistId, existing } = await loadPlaylist(client, SHOWCASE)

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

/**
 * Grows a second, append-only playlist so the feed can outlive the showcase's fixed size.
 * The showcase converges to PLAYLIST_SIZE and drops whatever falls out of today's top,
 * which caps the feed at 20; the archive only ever inserts, so it accumulates.
 *
 * Because the showcase is drawn from a rolling multi-day window, consecutive runs offer
 * mostly the same ids — the dedupe against what the archive already holds is what keeps
 * it from filling with repeats.
 *
 * @param {object} opts
 * @param {import("./client.js").YouTubeClient} opts.client
 * @param {string[]} opts.ranked - candidate video ids, best score first. Trimmed to the
 *   same PLAYLIST_SIZE the showcase uses, so the archive records what was shown.
 * @param {number} [opts.maxWrites] - ceiling on inserts issued this run.
 */
export async function appendToArchive({ client, ranked, maxWrites = MAX_ARCHIVE_WRITES_PER_RUN }) {
  return appendVideos({ client, videoIds: ranked.slice(0, PLAYLIST_SIZE), maxWrites })
}

/**
 * Inserts whatever the archive is missing, in the order given.
 *
 * Dedupe is against the playlist's live contents rather than a stored cursor, which is what
 * makes a long backfill resumable for free: a re-run skips everything already in, whether
 * the previous run stopped on its budget, on quota, or halfway through a crash.
 *
 * @param {object} opts
 * @param {import("./client.js").YouTubeClient} opts.client
 * @param {string[]} opts.videoIds - youtube video ids, oldest first.
 * @param {number} [opts.maxWrites] - ceiling on inserts issued this run.
 */
export async function appendVideos({ client, videoIds, maxWrites = MAX_ARCHIVE_WRITES_PER_RUN }) {
  const { playlistId, existing } = await loadPlaylist(client, ARCHIVE)

  const held = new Set(existing.map((e) => e.videoId))
  const fresh = []
  for (const videoId of videoIds) {
    if (held.has(videoId)) continue
    held.add(videoId)
    fresh.push(videoId)
  }

  const allowed = fresh.slice(0, maxWrites)
  let added = 0
  let quotaExhausted = false
  // No position argument: each insert lands at the end, so the playlist reads oldest first.
  for (const videoId of allowed) {
    try {
      await client.addVideoToPlaylist(playlistId, videoId)
    } catch (e) {
      // Running out of quota mid-backfill is expected, not a failure: stop where we are and
      // report it, so tomorrow's run picks up the remainder instead of starting over.
      if (e instanceof QuotaExceededError) {
        quotaExhausted = true
        break
      }
      throw e
    }
    added++
  }

  return {
    playlistId,
    added,
    remaining: fresh.length - added,
    skippedAdds: fresh.length - allowed.length,
    size: existing.length + added,
    quotaExhausted
  }
}
