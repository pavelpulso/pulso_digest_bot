import { parseISODuration } from "./duration.js"

const DEFAULT_BASE_URL = "https://www.googleapis.com/youtube/v3/"
const DEFAULT_OAUTH_URL = "https://oauth2.googleapis.com/token"
const BATCH_SIZE = 50
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_PAGES = 50

export class QuotaExceededError extends Error {
  name = "QuotaExceededError"
}

export class YouTubeClient {
  constructor({ clientId, clientSecret, refreshToken, baseUrl, oauthUrl, timeoutMs } = {}) {
    this.clientId = clientId ?? process.env.YOUTUBE_CLIENT_ID ?? ""
    this.clientSecret = clientSecret ?? process.env.YOUTUBE_CLIENT_SECRET ?? ""
    this.refreshToken = refreshToken ?? process.env.YOUTUBE_REFRESH_TOKEN ?? ""
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/?$/, "/")
    this.oauthUrl = oauthUrl ?? DEFAULT_OAUTH_URL
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.accessToken = null
    this.accessTokenExpiresAt = 0
  }

  isReady() {
    return !!(this.clientId && this.clientSecret && this.refreshToken)
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token"
    })
    const res = await this.#fetch(this.oauthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(`YouTube OAuth ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
    }
    this.accessToken = json.access_token
    // Минута форы, чтобы токен не истёк посреди серии запросов.
    this.accessTokenExpiresAt = Date.now() + ((json.expires_in || 3600) - 60) * 1000
    return this.accessToken
  }

  async #fetch(url, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } catch (e) {
      if (e.name === "AbortError" || e.name === "TimeoutError") {
        throw new Error(`Request to ${url} timed out after ${this.timeoutMs}ms`)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  async #get(path, params) {
    const token = await this.getAccessToken()
    const url = new URL(path, this.baseUrl)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const res = await this.#fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    })
    const json = await res.json().catch(() => null)

    if (res.status === 403 && JSON.stringify(json).includes("quotaExceeded")) {
      // Квота суточная — ретрай её не вернёт, только сожжёт остаток.
      throw new QuotaExceededError("YouTube daily quota exhausted")
    }
    if (!res.ok) {
      throw new Error(`YouTube ${path} ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
    }
    return json
  }

  async #paged(path, params, onPage) {
    let pageToken = ""
    const seenTokens = new Set()
    let pages = 0
    do {
      const json = await this.#get(path, pageToken ? { ...params, pageToken } : params)
      const more = onPage(json.items || [])
      pageToken = json.nextPageToken || ""
      pages++
      if (more === false) return
      if (pageToken) {
        if (seenTokens.has(pageToken)) {
          throw new Error(`YouTube ${path}: nextPageToken repeated, aborting pagination`)
        }
        seenTokens.add(pageToken)
        if (pages >= MAX_PAGES) {
          throw new Error(`YouTube ${path}: exceeded ${MAX_PAGES} pages, aborting pagination`)
        }
      }
    } while (pageToken)
  }

  async listSubscriptions() {
    const out = []
    await this.#paged("subscriptions", { part: "snippet", mine: "true", maxResults: String(BATCH_SIZE) }, (items) => {
      for (const it of items) {
        const channelId = it.snippet?.resourceId?.channelId
        if (channelId) out.push({ channelId, title: it.snippet?.title || channelId })
      }
    })
    return out
  }

  async listUploadPlaylists(channelIds) {
    const map = new Map()
    for (let i = 0; i < channelIds.length; i += BATCH_SIZE) {
      const batch = channelIds.slice(i, i + BATCH_SIZE)
      const json = await this.#get("channels", { part: "contentDetails", id: batch.join(","), maxResults: String(BATCH_SIZE) })
      for (const it of json.items || []) {
        const uploads = it.contentDetails?.relatedPlaylists?.uploads
        if (uploads) map.set(it.id, uploads)
      }
    }
    return map
  }

  async listPlaylistVideos(playlistId, sinceIso) {
    const out = []
    await this.#paged("playlistItems", { part: "contentDetails", playlistId, maxResults: String(BATCH_SIZE) }, (items) => {
      for (const it of items) {
        const videoId = it.contentDetails?.videoId
        const publishedAt = it.contentDetails?.videoPublishedAt
        if (videoId && publishedAt && publishedAt >= sinceIso) out.push({ videoId, publishedAt })
      }
      // Плейлист загрузок отсортирован от новых к старым: если последний элемент
      // страницы уже вне окна, дальше только старее — качать всю историю незачем.
      const last = items[items.length - 1]?.contentDetails?.videoPublishedAt
      return !(last && last < sinceIso)
    })
    return out
  }

  /** Newest video in the uploads playlist, or null if it's empty. One request, no paging. */
  async listLatestPlaylistVideo(playlistId) {
    const json = await this.#get("playlistItems", { part: "contentDetails", playlistId, maxResults: "1" })
    const it = (json.items || [])[0]
    const videoId = it?.contentDetails?.videoId
    const publishedAt = it?.contentDetails?.videoPublishedAt
    return videoId && publishedAt ? { videoId, publishedAt } : null
  }

  async listVideoDetails(videoIds) {
    const out = []
    for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
      const batch = videoIds.slice(i, i + BATCH_SIZE)
      const json = await this.#get("videos", {
        part: "snippet,statistics,contentDetails",
        id: batch.join(","),
        maxResults: String(BATCH_SIZE)
      })
      for (const it of json.items || []) {
        out.push({
          videoId: it.id,
          title: it.snippet?.title || "",
          description: it.snippet?.description || "",
          channelTitle: it.snippet?.channelTitle || "",
          publishedAt: it.snippet?.publishedAt || "",
          views: parseInt(it.statistics?.viewCount, 10) || 0,
          durationSec: parseISODuration(it.contentDetails?.duration)
        })
      }
    }
    return out
  }
}
