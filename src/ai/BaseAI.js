/**
 * Базовый класс для AI-провайдеров.
 * Определяет общий интерфейс и общую логику для всех реализаций.
 */
import {
  buildRankPrompt,
  buildSummaryPrompt,
  buildAnalyzeChannelPrompt,
  buildAuditAllChannelsPrompt,
  buildRecommendChannelsPrompt
} from "./prompts.js"
import { LIMITS, JSON_ARRAY_KEYS, VERDICTS, MAX_RETRIES, RETRY_DELAY_MS } from "./constants.js"

export class BaseAI {
  constructor(name) {
    if (new.target === BaseAI) {
      throw new Error("BaseAI is abstract and cannot be instantiated directly")
    }
    this.name = name
  }

  async isReady() {
    throw new Error("Method 'isReady()' must be implemented")
  }

  /**
   * Запрос к API с retry при 429.
   * @protected
   */
  async #chatWithRetry(url, apiKey, body, maxRetries = MAX_RETRIES) {
    let lastError = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(body)
        })

        if (res.status === 429) {
          const waitMs = RETRY_DELAY_MS * attempt
          console.log(`[${this.name}] 429 Too Many Requests. Retry ${attempt}/${maxRetries} after ${waitMs}ms`)
          await new Promise(r => setTimeout(r, waitMs))
          continue
        }

        if (!res.ok) {
          const errText = await res.text()
          throw new Error(`${this.name} API ${res.status}: ${errText}`)
        }

        const data = await res.json()
        const text = data.choices?.[0]?.message?.content
        if (text == null) throw new Error(`${this.name} API: empty response`)
        return text
      } catch (e) {
        if (e.message.includes("429") && attempt < maxRetries) {
          lastError = e
          continue
        }
        throw e
      }
    }

    throw lastError || new Error(`${this.name} API: max retries exceeded`)
  }

  /**
   * Парсинг JSON-массива из ответа.
   * @protected
   */
  #parseJSONArray(raw) {
    const cleaned = raw.replace(/```\w*\n?/g, "").trim()
    let parsed
    try {
      parsed = JSON.parse(cleaned)
    } catch (e) {
      throw new Error(`${this.name}: invalid JSON`)
    }
    if (Array.isArray(parsed)) return parsed
    for (const key of JSON_ARRAY_KEYS) {
      if (parsed && Array.isArray(parsed[key])) return parsed[key]
    }
    const firstArr = Object.values(parsed || {}).find(Array.isArray)
    if (firstArr) return firstArr
    throw new Error(`${this.name}: expected array in JSON`)
  }

  /**
   * Парсинг JSON-объекта из ответа.
   * @protected
   */
  #parseJSONObject(raw) {
    const cleaned = raw.replace(/```\w*\n?/g, "").trim()
    try {
      return JSON.parse(cleaned)
    } catch (e) {
      throw new Error(`${this.name}: invalid JSON`)
    }
  }

  async rankPosts(posts, userProfile = "", options = {}) {
    if (posts.length === 0) return []

    const { onProgress } = options
    if (typeof onProgress === "function") onProgress(10)

    const list = posts.map((p) => ({
      id: p.id,
      channel: p.channel,
      text: (p.text || "").slice(0, LIMITS.RANK_TEXT)
    }))

    const channelPriorities = options.channelPriorities || {}
    const importantChannels = Object.entries(channelPriorities)
      .filter(([, p]) => p === 2)
      .map(([ch]) => ch)
      .join(", ")

    const feedback = options.feedback || {}
    const liked = feedback.liked || []
    const disliked = feedback.disliked || []

    const prompt = buildRankPrompt(list, userProfile, importantChannels, liked, disliked)

    if (typeof onProgress === "function") onProgress(50)
    const raw = await this._callAPI(prompt, { type: "json_object" })
    if (typeof onProgress === "function") onProgress(80)

    const parsed = this.#parseJSONArray(raw)
    if (typeof onProgress === "function") onProgress(100)

    return parsed.map((item) => ({
      post_id: String(item.post_id),
      score: Number(item.score) || 0,
      reason: String(item.reason || "")
    }))
  }

  async generateSummaryBlocks(posts, dateLabel, userProfile = "", maxItems = 10, options = {}) {
    if (posts.length === 0) return { teaser: null, blocks: [] }

    const { onProgress } = options
    if (typeof onProgress === "function") onProgress(10)

    const list = posts.map((p) => ({
      id: p.id,
      channel: p.channel,
      post_id: p.post_id,
      text: (p.text || "").slice(0, LIMITS.SUMMARY_TEXT),
      link: p.link
    }))

    const maxBlocks = Math.min(LIMITS.MAX_BLOCKS, Math.max(LIMITS.MIN_BLOCKS, maxItems))
    const prompt = buildSummaryPrompt(list, dateLabel, userProfile, maxBlocks)

    if (typeof onProgress === "function") onProgress(50)
    const raw = await this._callAPI(prompt, { type: "json_object" })
    if (typeof onProgress === "function") onProgress(75)

    const parsed = this.#parseJSONObject(raw)
    const teaser = typeof parsed.teaser === "string" ? parsed.teaser.trim().slice(0, LIMITS.TEASER_WORDS * 10) : null
    const rawBlocks = Array.isArray(parsed) ? parsed : (parsed.blocks || [])

    const idSet = new Set(list.map((p) => p.id))
    const seenIds = new Set()

    const blocks = rawBlocks
      .map((item) => {
        const ids = Array.isArray(item.ids) ? item.ids : (item.id != null ? [String(item.id)] : [])
        const validIds = ids.filter((id) => idSet.has(String(id)) && !seenIds.has(String(id)))
        validIds.forEach((id) => seenIds.add(String(id)))
        if (validIds.length === 0) return null
        return {
          ids: validIds,
          essence: String(item.essence || "").trim(),
          potential: String(item.potential || "").trim(),
          emoji: String(item.emoji || "📌").trim().slice(0, 2),
          action: String(item.action || "").trim()
        }
      })
      .filter(Boolean)

    if (typeof onProgress === "function") onProgress(100)
    return { teaser, blocks: blocks.slice(0, maxBlocks) }
  }

  async analyzeChannel(posts, channel, userProfile = "") {
    const list = posts.map((p) => ({
      text: (p.text || "").slice(0, LIMITS.ANALYZE_TEXT),
      link: p.link
    }))

    const prompt = buildAnalyzeChannelPrompt(channel, userProfile, list)
    const raw = await this._callAPI(prompt, { type: "json_object" })
    const parsed = this.#parseJSONObject(raw)

    return {
      score: Number(parsed.score) || 0,
      signal_noise: Number(parsed.signal_noise) || 0,
      verdict: VERDICTS.includes(parsed.verdict) ? parsed.verdict : "mute",
      summary: String(parsed.summary || "").trim().slice(0, LIMITS.SUMMARY_WORDS * 15),
      arguments: Array.isArray(parsed.arguments)
        ? parsed.arguments.slice(0, 3).map((a) => String(a).trim())
        : []
    }
  }

  async auditAllChannels(channelsData, userProfile = "") {
    if (channelsData.length === 0) return []

    const list = channelsData.map((cd) => ({
      channel: cd.channel,
      postCount: cd.posts.length,
      posts: cd.posts.slice(0, LIMITS.MAX_POSTS_ANALYZE).map((p) => ({
        text: (p.text || "").slice(0, LIMITS.AUDIT_TEXT),
        views: p.views || 0
      }))
    }))

    let arr = []
    try {
      const prompt = buildAuditAllChannelsPrompt(userProfile, list)
      const raw = await this._callAPI(prompt, { type: "json_object", maxTokens: 2048 })
      const parsed = this.#parseJSONObject(raw)
      arr = Array.isArray(parsed) ? parsed : (parsed.channels || [])
    } catch (e) {
      console.warn("[auditAllChannels] AI failed, using fallback:", e.message)
      // Fallback: вернуть каналы без AI оценок
      return channelsData.map((cd) => {
        const postCount = cd.posts.length || 1
        const totalViews = cd.posts.reduce((sum, p) => sum + (p.views || 0), 0) || 0
        return {
          channel: cd.channel,
          score: 0,
          avgPostQuality: 0,
          signalNoise: 0.5,
          avgViews: Math.round(totalViews / postCount),
          valuePerPost: 0,
          verdict: "mute",
          summary: "Нет данных (AI недоступен)"
        }
      }).sort((a, b) => b.avgViews - a.avgViews)
    }

    const known = new Set(channelsData.map((cd) => cd.channel.toLowerCase()))
    const channelDataMap = new Map(channelsData.map((cd) => [cd.channel.toLowerCase(), cd]))

    return arr
      .filter((item) => known.has(String(item.channel || "").toLowerCase()))
      .map((item) => {
        const channelKey = String(item.channel).toLowerCase()
        const cd = channelDataMap.get(channelKey)
        const postCount = cd?.posts?.length || 1
        const totalViews = cd?.posts?.reduce((sum, p) => sum + (p.views || 0), 0) || 0

        return {
          channel: channelKey,
          score: Number(item.score) || 0,
          avgViews: Number(item.avg_views) ?? Math.round(totalViews / postCount),
          verdict: ["keep", "review", "mute"].includes(item.verdict) ? item.verdict : "mute",
          summary: String(item.summary || "").trim().slice(0, 200),
          reason: String(item.reason || "").trim().slice(0, 400),
          problemType: ["spam", "irrelevant", "low_quality", "promo", "outdated", "low_frequency", "duplicate", "noise", "too_basic", "none"].includes(item.problem_type) ? item.problem_type : "none",
          scoreBreakdown: {
            quality: Number(item.score_breakdown?.quality) || 0.5,
            relevance: Number(item.score_breakdown?.relevance) || 0.5,
            spamFree: Number(item.score_breakdown?.spam_free) || 1.0
          },
          recommendation: ["remove", "keep", "keep_if", "mute_temporarily"].includes(item.recommendation) ? item.recommendation : "remove",
          keepIfCondition: String(item.keep_if_condition || "").trim().slice(0, 150)
        }
      })
      .sort((a, b) => b.score - a.score)
  }

  async recommendChannels(userProfile, channelUsernames) {
    if (!channelUsernames?.length) return []

    const list = channelUsernames.slice(0, LIMITS.MAX_CHANNELS_ANALYZE)
    const prompt = buildRecommendChannelsPrompt(userProfile, list)

    const raw = await this._callAPI(prompt, { type: "json_object", maxTokens: 1024 })
    const parsed = this.#parseJSONObject(raw)
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed.channels || parsed.recommendations || parsed.result || parsed.items || Object.values(parsed).find(Array.isArray) || [])

    const set = new Set(list.map((u) => u.toLowerCase()))

    return arr
      .filter((item) => set.has(String(item.username || item.channel || "").toLowerCase()))
      .slice(0, LIMITS.MAX_RECOMMENDATIONS)
      .map((item) => ({
        username: String(item.username || item.channel || "").toLowerCase(),
        reason: String(item.reason || "").trim().slice(0, 150)
      }))
  }

  async _callAPI(prompt, options) {
    throw new Error("Method '_callAPI()' must be implemented")
  }

  toString() {
    return this.name
  }
}
