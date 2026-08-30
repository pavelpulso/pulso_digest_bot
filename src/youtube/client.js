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

  /** Shared non-ok handling for #get and #mutate. `reason` comes from Google's classic
   * error format (error.errors[0].reason) so callers can match a specific failure —
   * e.g. playlistNotFound — instead of guessing from a truncated message string. */
  #throwOnError(res, json, path, { isWrite = false } = {}) {
    if (res.ok) return
    const reason = json?.error?.errors?.[0]?.reason
    if (res.status === 403 && reason === "quotaExceeded") {
      // Квота суточная — ретрай её не вернёт, только сожжёт остаток.
      throw new QuotaExceededError("YouTube daily quota exhausted")
    }
    if (isWrite && res.status === 403) {
      // Most likely 403 right after shipping write support: the stored refresh token
      // still carries the old read-only scope, and every write fails until reissued.
      throw new Error(
        `YouTube ${path} 403: looks like a scope problem, not quota. Re-run "npm run auth:youtube" ` +
        `to reissue the refresh token with youtube.force-ssl, then update YOUTUBE_REFRESH_TOKEN.`
      )
    }
    const err = new Error(`YouTube ${path} ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
    err.status = res.status
    err.reason = reason
    throw err
  }

  async #get(path, params) {
    const token = await this.getAccessToken()
    const url = new URL(path, this.baseUrl)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const res = await this.#fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    })
    const json = await res.json().catch(() => null)
    this.#throwOnError(res, json, path)
    return json
  }

  async #mutate(method, path, { params = {}, body } = {}) {
    const token = await this.getAccessToken()
    const url = new URL(path, this.baseUrl)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const res = await this.#fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    const json = await res.json().catch(() => null)
    this.#throwOnError(res, json, path, { isWrite: true })
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

  async listVideoDetails(videoIds) {
    const out = []
    for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
      const batch = videoIds.slice(i, i + BATCH_SIZE)
      let json
      try {
        json = await this.#get("videos", {
          part: "snippet,statistics,contentDetails",
          id: batch.join(","),
          maxResults: String(BATCH_SIZE)
        })
      } catch (e) {
        e.partial = out
        throw e
      }
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

  /** Private by default — this is the user's own queue, not something to publish. */
  async createPlaylist(title, description) {
    const json = await this.#mutate("POST", "playlists", {
      params: { part: "snippet,status" },
      body: { snippet: { title, description }, status: { privacyStatus: "private" } }
    })
    return json.id
  }

  async addVideoToPlaylist(playlistId, videoId, position) {
    const snippet = { playlistId, resourceId: { kind: "youtube#video", videoId } }
    if (position !== undefined) snippet.position = position
    const json = await this.#mutate("POST", "playlistItems", {
      params: { part: "snippet" },
      body: { snippet }
    })
    return json.id
  }

  /** Newest-first liked video ids. `maxPages` defaults to 2 (100 videos): we only want
   * recent likes to turn into feedback, and a user with a lifelong like history must not
   * turn this into an unbounded crawl at 1 quota unit per page. */
  async listLikedVideos({ maxPages = 2 } = {}) {
    const out = []
    let pageToken = ""
    let pages = 0
    do {
      const json = await this.#get("videos", {
        part: "id",
        myRating: "like",
        maxResults: String(BATCH_SIZE),
        ...(pageToken ? { pageToken } : {})
      })
      for (const it of json.items || []) {
        if (it.id) out.push(it.id)
      }
      pageToken = json.nextPageToken || ""
      pages++
    } while (pageToken && pages < maxPages)
    return out
  }

  /** Returns both ids: removing an entry needs the playlistItem id, not the video id. */
  async listPlaylistItemIds(playlistId) {
    const out = []
    await this.#paged("playlistItems", { part: "snippet", playlistId, maxResults: String(BATCH_SIZE) }, (items) => {
      for (const it of items) {
        const videoId = it.snippet?.resourceId?.videoId
        if (videoId) out.push({ playlistItemId: it.id, videoId })
      }
    })
    return out
  }

  async removePlaylistItem(playlistItemId) {
    await this.#mutate("DELETE", "playlistItems", { params: { id: playlistItemId } })
  }
}
