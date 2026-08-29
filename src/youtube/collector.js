import { v4 as uuidv4 } from "uuid"
import { isShort } from "./duration.js"
import { QuotaExceededError } from "./client.js"
import {
  getYouTubeChannels,
  upsertYouTubeChannel,
  markChannelUnsubscribed,
  upsertVideo
} from "../db.js"

const WINDOW_DAYS = 7

/**
 * Собирает видео с подписок за окно. Список подписок синхронизируется каждый
 * прогон: новые каналы добавляются, отписки помечаются, но не удаляются —
 * их прошлые видео нужны для медианы канала и для post_feedback.
 */
export async function collectYouTubeVideos({ client, now = new Date(), addedBy = 0 } = {}) {
  const errors = []
  const perChannel = []

  if (!client || !client.isReady()) {
    console.log("[collectYouTubeVideos] YouTube not configured, skipping.")
    return { collected: 0, errors, perChannel }
  }

  try {
    await syncSubscriptions(client, addedBy, errors)
  } catch (e) {
    errors.push(`subscriptions: ${e.message}`)
    if (e instanceof QuotaExceededError) return { collected: 0, errors, perChannel }
  }

  const channels = getYouTubeChannels()
  if (channels.length === 0) {
    return { collected: 0, errors, perChannel }
  }

  const sinceIso = new Date(now.getTime() - WINDOW_DAYS * 86400_000).toISOString()
  const pending = []

  for (const ch of channels) {
    if (!ch.external_id) continue
    try {
      const videos = await client.listPlaylistVideos(ch.external_id, sinceIso)
      for (const v of videos) pending.push({ ...v, channel: ch.username })
      perChannel.push({ channel: ch.username, count: videos.length })
    } catch (e) {
      errors.push(`${ch.username}: ${e.message}`)
      perChannel.push({ channel: ch.username, count: 0, error: e.message })
      // Квота ушла на весь день — дальше по каналам гонять нет смысла, только время сожжём.
      // Но то, что уже собрано в pending, стоило реальных запросов — не выбрасываем.
      if (e instanceof QuotaExceededError) break
    }
  }

  if (pending.length === 0) return { collected: 0, errors, perChannel }

  let details = []
  try {
    details = await client.listVideoDetails(pending.map((p) => p.videoId))
  } catch (e) {
    errors.push(`videos: ${e.message}`)
    return { collected: 0, errors, perChannel }
  }

  const channelByVideo = new Map(pending.map((p) => [p.videoId, p.channel]))
  let collected = 0

  for (const d of details) {
    if (isShort(d.durationSec)) continue
    const channel = channelByVideo.get(d.videoId)
    if (!channel) continue
    const text = d.description ? `${d.title}\n\n${d.description}` : d.title
    upsertVideo(
      uuidv4(),
      channel,
      d.videoId,
      text,
      `https://www.youtube.com/watch?v=${d.videoId}`,
      d.views,
      d.durationSec,
      d.publishedAt
    )
    collected++
  }

  console.log(`[collectYouTubeVideos] Finished. Total: ${collected} videos, ${errors.length} errors.`)
  return { collected, errors, perChannel }
}

async function syncSubscriptions(client, addedBy, errors) {
  const subs = await client.listSubscriptions()
  if (subs.length === 0) return

  const known = new Map(getYouTubeChannels().map((c) => [c.username, c]))
  const seenBy = new Map() // username -> channelId первой подписки в этом прогоне

  const missingPlaylists = []
  for (const s of subs) {
    const username = `yt:${s.title}`
    if (seenBy.has(username)) {
      errors.push(`subscriptions: "${s.title}" collides between channels ${seenBy.get(username)} and ${s.channelId} — only the first is collected`)
      continue
    }
    seenBy.set(username, s.channelId)
    if (!known.has(username) || !known.get(username).external_id) {
      missingPlaylists.push({ username, channelId: s.channelId })
    }
  }

  if (missingPlaylists.length > 0) {
    const uploads = await client.listUploadPlaylists(missingPlaylists.map((m) => m.channelId))
    for (const m of missingPlaylists) {
      const playlist = uploads.get(m.channelId)
      if (playlist) upsertYouTubeChannel(m.username, playlist, addedBy)
    }
  }

  for (const username of known.keys()) {
    if (!seenBy.has(username)) markChannelUnsubscribed(username)
  }
}
