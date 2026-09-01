import { v4 as uuidv4 } from "uuid"
import { isShort } from "./duration.js"
import { QuotaExceededError } from "./client.js"
import { fetchFeeds as defaultFetchFeeds, FEED_ENTRY_CAP } from "./rss.js"
import {
  getYouTubeChannels,
  upsertYouTubeChannel,
  markChannelUnsubscribed,
  upsertVideo,
  getActiveYouTubeChannels,
  getDormantYouTubeChannelsDueForRecheck,
  updateChannelActivity
} from "../db.js"

const WINDOW_DAYS = 7
export const ACTIVE_DAYS = 180
export const RECHECK_DAYS = 7

/**
 * Собирает видео с подписок за окно. Список подписок синхронизируется каждый
 * прогон: новые каналы добавляются, отписки помечаются, но не удаляются —
 * их прошлые видео нужны для медианы канала и для post_feedback.
 */
export async function collectYouTubeVideos({ client, now = new Date(), addedBy = 0, fetchFeeds = defaultFetchFeeds } = {}) {
  const errors = []
  const warnings = []
  const perChannel = []

  if (!client || !client.isReady()) {
    console.log("[collectYouTubeVideos] YouTube not configured, skipping.")
    return { collected: 0, errors, warnings, perChannel }
  }

  try {
    await syncSubscriptions(client, addedBy, errors, warnings)
  } catch (e) {
    errors.push(`subscriptions: ${e.message}`)
    if (e instanceof QuotaExceededError) return { collected: 0, errors, warnings, perChannel }
  }

  const channels = [
    ...getActiveYouTubeChannels(ACTIVE_DAYS),
    ...getDormantYouTubeChannelsDueForRecheck(ACTIVE_DAYS, RECHECK_DAYS)
  ]
  if (channels.length === 0) {
    return { collected: 0, errors, warnings, perChannel }
  }

  const sinceIso = new Date(now.getTime() - WINDOW_DAYS * 86400_000).toISOString()
  const channelIds = channels.filter((ch) => ch.external_id).map((ch) => ch.external_id)
  const { byChannel, errors: feedErrors } = await fetchFeeds(channelIds)
  const feedErrorByChannelId = new Map(feedErrors.map((fe) => [fe.channelId, fe.message]))

  const pending = []
  for (const ch of channels) {
    if (!ch.external_id) continue
    const feedError = feedErrorByChannelId.get(ch.external_id)
    if (feedError) {
      errors.push(`${ch.username}: ${feedError}`)
      perChannel.push({ channel: ch.username, count: 0, error: feedError })
      updateChannelActivity(ch.username, {})
      continue
    }
    const feed = byChannel.get(ch.external_id) || []
    const videos = feed.filter((v) => v.publishedAt >= sinceIso)
    if (feed.length === FEED_ENTRY_CAP && videos.length === FEED_ENTRY_CAP) {
      warnings.push(`${ch.username}: feed returned ${FEED_ENTRY_CAP} entries, all inside the window — may be truncated, older in-window videos could be missing`)
    }
    for (const v of videos) pending.push({ ...v, channel: ch.username })
    perChannel.push({ channel: ch.username, count: videos.length })
    const newest = videos.reduce((max, v) => (!max || v.publishedAt > max ? v.publishedAt : max), null)
    updateChannelActivity(ch.username, { lastVideoAt: newest })
  }

  if (pending.length === 0) return { collected: 0, errors, warnings, perChannel }

  let details = []
  try {
    details = await client.listVideoDetails(pending.map((p) => p.videoId))
  } catch (e) {
    errors.push(`videos: ${e.message}`)
    details = e.partial || []
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
      d.publishedAt,
      d.likes ?? null
    )
    collected++
  }

  console.log(`[collectYouTubeVideos] Finished. Total: ${collected} videos, ${errors.length} errors.`)
  return { collected, errors, warnings, perChannel }
}

/**
 * Ручной прогон для классификации накопленных подписок: по одному запросу на канал
 * (RSS, бесплатно) узнаём дату последнего видео, без выкачивания истории. Безопасно перезапускать.
 */
export async function backfillChannelActivity({ client, fetchFeeds = defaultFetchFeeds } = {}) {
  const results = []
  if (!client || !client.isReady()) return results

  const channels = getYouTubeChannels().filter((ch) => ch.external_id)
  const channelIds = channels.map((ch) => ch.external_id)
  const { byChannel, errors: feedErrors } = await fetchFeeds(channelIds)
  const feedErrorByChannelId = new Map(feedErrors.map((fe) => [fe.channelId, fe.message]))

  for (const ch of channels) {
    const feedError = feedErrorByChannelId.get(ch.external_id)
    if (feedError) {
      updateChannelActivity(ch.username, {})
      results.push({ channel: ch.username, error: feedError })
      continue
    }
    const latest = (byChannel.get(ch.external_id) || [])[0] || null
    updateChannelActivity(ch.username, { lastVideoAt: latest?.publishedAt })
    results.push({ channel: ch.username, lastVideoAt: latest?.publishedAt || null })
  }
  return results
}

async function syncSubscriptions(client, addedBy, errors, warnings) {
  const subs = await client.listSubscriptions()
  if (subs.length === 0) return

  const known = new Map(getYouTubeChannels().map((c) => [c.username, c]))
  const seenBy = new Map() // username -> channelId первой подписки в этом прогоне

  for (const s of subs) {
    const username = `yt:${s.title}`
    if (seenBy.has(username)) {
      warnings.push(`subscriptions: "${s.title}" collides between channels ${seenBy.get(username)} and ${s.channelId} — only the first is collected`)
      continue
    }
    seenBy.set(username, s.channelId)
    if (!known.has(username) || known.get(username).external_id !== s.channelId) {
      upsertYouTubeChannel(username, s.channelId, addedBy)
    }
  }

  for (const username of known.keys()) {
    if (!seenBy.has(username)) markChannelUnsubscribed(username)
  }
}
