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
   * Парсинг JSON-массива из ответа.
   * @protected
   */
  #parseJSONArray(raw) {
    const cleaned = raw.replace(/```\w*\n?/g, "").trim()
    
    // Найти первую [ и последнюю ]
    // Это нужно т.к. AI может добавлять текст до и после JSON
    const startIndex = cleaned.indexOf('[')
    const endIndex = cleaned.lastIndexOf(']')
    
    let jsonStr = cleaned
    if (startIndex >= 0 && endIndex > startIndex) {
      jsonStr = cleaned.slice(startIndex, endIndex + 1)
    }
    
    let parsed
    try {
      parsed = JSON.parse(jsonStr)
    } catch (e) {
      console.error("[#parseJSONArray] Failed to parse JSON:")
      console.error("JSON string (first 500 chars):", jsonStr.slice(0, 500))
      throw new Error(`${this.name}: invalid JSON - ${e.message}`)
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
    
    console.log("[#parseJSONObject] Raw response preview:", raw.slice(0, 100))
    console.log("[#parseJSONObject] Cleaned preview:", cleaned.slice(0, 100))
    
    // Найти первую { и последнюю }
    // Это нужно т.к. AI может добавлять текст до и после JSON
    const startIndex = cleaned.indexOf('{')
    const endIndex = cleaned.lastIndexOf('}')
    
    let jsonStr = cleaned
    if (startIndex >= 0 && endIndex > startIndex) {
      jsonStr = cleaned.slice(startIndex, endIndex + 1)
    }
    
    console.log("[#parseJSONObject] JSON string preview:", jsonStr.slice(0, 200))
    
    try {
      return JSON.parse(jsonStr)
    } catch (e) {
      console.error("[#parseJSONObject] Failed to parse JSON:")
      console.error("Full JSON string:", jsonStr)
      throw new Error(`${this.name}: invalid JSON - ${e.message}`)
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

  async auditAllChannels(channelsData, userProfile = "", options = {}) {
    if (channelsData.length === 0) return []

    const { onProgress } = options
    const BATCH_SIZE = 15
    const batches = []
    
    // Разбиваем на батчи по 15 каналов
    for (let i = 0; i < channelsData.length; i += BATCH_SIZE) {
      batches.push(channelsData.slice(i, i + BATCH_SIZE))
    }

    const allResults = []
    let completedBatches = 0

    // Обрабатываем каждый батч
    for (const batch of batches) {
      const list = batch.map((cd) => ({
        channel: cd.channel,
        postCount: cd.posts.length,
        posts: cd.posts.slice(0, LIMITS.MAX_POSTS_ANALYZE).map((p) => ({
          text: (p.text || "").slice(0, LIMITS.AUDIT_TEXT),
          views: p.views || 0
        }))
      }))

      try {
        const prompt = buildAuditAllChannelsPrompt(userProfile, list)
        console.log(`[auditAllChannels] Processing batch: ${batch.length} channels, prompt length: ${prompt.length}`)
        const raw = await this._callAPI(prompt, { type: "json_object", maxTokens: 2048 })
        console.log(`[auditAllChannels] Raw response (first 300 chars):`, raw.slice(0, 300))
        const parsed = this.#parseJSONObject(raw)
        console.log(`[auditAllChannels] Parsed channels:`, Array.isArray(parsed) ? parsed.length : (parsed.channels?.length || 0))
        const batchResults = Array.isArray(parsed) ? parsed : (parsed.channels || [])
        allResults.push(...batchResults)
      } catch (e) {
        console.warn(`[auditAllChannels] Batch failed for ${batch.length} channels:`, e.message)
        console.error("Full error:", e)
        // Fallback для этого батча
        for (const cd of batch) {
          const postCount = cd.posts.length || 1
          const totalViews = cd.posts.reduce((sum, p) => sum + (p.views || 0), 0) || 0
          allResults.push({
            channel: cd.channel,
            score: 0,
            avg_views: Math.round(totalViews / postCount),
            verdict: "mute",
            summary: "Нет данных (AI недоступен)",
            reason: "Не удалось получить оценку AI",
            problem_type: "none"
          })
        }
      }

      completedBatches++
      if (typeof onProgress === "function") {
        const analyzedChannels = Math.min(completedBatches * BATCH_SIZE, channelsData.length)
        const pct = Math.round((analyzedChannels / channelsData.length) * 100)
        onProgress({ analyzedChannels, totalChannels: channelsData.length, percent: pct, completedBatches, totalBatches: batches.length })
      }
    }

    const known = new Set(channelsData.map((cd) => cd.channel.toLowerCase()))
    const channelDataMap = new Map(channelsData.map((cd) => [cd.channel.toLowerCase(), cd]))

    return allResults
      .filter((item) => known.has(String(item.channel || "").toLowerCase()))
      .map((item) => {
        const channelKey = String(item.channel).toLowerCase()
        const cd = channelDataMap.get(channelKey)
        const postCount = cd?.posts?.length || 1
        const totalViews = cd?.posts?.reduce((sum, p) => sum + (p.views || 0), 0) || 0

        return {
          channel: channelKey,
          score: Number(item.score) || 0,
          avgViews: Number(item.avg_views) || Math.round(totalViews / postCount),
          verdict: ["keep", "review", "mute"].includes(item.verdict) ? item.verdict : "mute",
          summary: item.summary ? String(item.summary).trim().slice(0, 200) : "Нет описания",
          reason: item.reason ? String(item.reason).trim().slice(0, 400) : "Нет обоснования",
          problemType: ["spam", "irrelevant", "low_quality", "promo", "outdated", "low_frequency", "duplicate", "noise", "too_basic", "none"].includes(item.problem_type) ? item.problem_type : "none",
          scoreBreakdown: {
            quality: Number(item.score_breakdown?.quality) || 0.5,
            relevance: Number(item.score_breakdown?.relevance) || 0.5,
            spamFree: Number(item.score_breakdown?.spam_free) || 1.0
          },
          recommendation: ["remove", "keep", "keep_if", "mute_temporarily"].includes(item.recommendation) ? item.recommendation : "remove",
          keepIfCondition: item.keep_if_condition ? String(item.keep_if_condition).trim().slice(0, 150) : ""
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
