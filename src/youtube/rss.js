const DEFAULT_BASE_URL = "https://www.youtube.com/"
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_CONCURRENCY = 15

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&#39;": "'"
}

function decodeEntities(s) {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m])
}

function extract(block, regex) {
  const m = regex.exec(block)
  return m ? m[1] : null
}

/** Free public per-channel feed, no key/OAuth/quota. Newest-first, up to 15 videos, no duration. */
export function parseChannelFeed(xml) {
  try {
    if (typeof xml !== "string") return []
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || []
    const videos = []
    for (const entry of entries) {
      const videoId = extract(entry, /<yt:videoId>([^<]+)<\/yt:videoId>/)
      const publishedAt = extract(entry, /<published>([^<]+)<\/published>/)
      if (!videoId || !publishedAt) continue
      const title = extract(entry, /<media:title>([^<]*)<\/media:title>/)
      const description = extract(entry, /<media:description>([\s\S]*?)<\/media:description>/)
      const viewsStr = extract(entry, /<media:statistics\s+views="([^"]*)"/)
      videos.push({
        videoId,
        publishedAt,
        title: decodeEntities(title || ""),
        description: decodeEntities(description || ""),
        views: parseInt(viewsStr, 10) || 0
      })
    }
    return videos
  } catch {
    return []
  }
}

export async function fetchChannelFeed(channelId, { baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL("feeds/videos.xml", baseUrl)
  url.searchParams.set("channel_id", channelId)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetch(url.toString(), { signal: controller.signal })
  } catch (e) {
    if (e.name === "AbortError" || e.name === "TimeoutError") {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw new Error(`YouTube RSS ${channelId} ${res.status}`)
  }
  return parseChannelFeed(await res.text())
}

/** Bounded-concurrency worker pool over 845 channels — never a single Promise.all. */
export async function fetchFeeds(channelIds, { concurrency = DEFAULT_CONCURRENCY, baseUrl, timeoutMs } = {}) {
  const byChannel = new Map()
  const errors = []
  let next = 0

  async function worker() {
    while (next < channelIds.length) {
      const channelId = channelIds[next++]
      try {
        byChannel.set(channelId, await fetchChannelFeed(channelId, { baseUrl, timeoutMs }))
      } catch (e) {
        errors.push({ channelId, message: e.message })
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, channelIds.length) }, () => worker())
  await Promise.all(workers)

  return { byChannel, errors }
}
