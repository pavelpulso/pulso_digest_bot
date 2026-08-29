/**
 * Base class for AI providers.
 * Defines common interface and logic for all implementations.
 */
import {
  buildRankPrompt,
  buildSummaryPrompt,
  buildAnalyzeChannelPrompt,
  buildAuditAllChannelsPrompt,
  buildRecommendChannelsPrompt
} from "./prompts.js"
import { LIMITS, JSON_ARRAY_KEYS, VERDICTS } from "./constants.js"

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
   * Parse JSON array from response.
   * @protected
   */
  #parseJSONArray(raw) {
    const cleaned = raw.replace(/```\w*\n?/g, "").trim()

    // Try each '[' occurrence — model may prefix with non-JSON text like "[Rules applied: ...]"
    let searchFrom = 0
    while (true) {
      const startIndex = cleaned.indexOf("[", searchFrom)
      if (startIndex === -1) throw new Error(`${this.name}: no JSON array found`)

      // Bracket tracking to find matching ]
      let depth = 0
      let endIndex = -1
      for (let i = startIndex; i < cleaned.length; i++) {
        if (cleaned[i] === "[") depth++
        else if (cleaned[i] === "]") {
          depth--
          if (depth === 0) { endIndex = i; break }
        }
      }

      const jsonStr = endIndex > startIndex
        ? cleaned.slice(startIndex, endIndex + 1)
        : cleaned.slice(startIndex)

      try {
        const parsed = JSON.parse(jsonStr)
        if (Array.isArray(parsed)) return parsed
        for (const key of JSON_ARRAY_KEYS) {
          if (parsed && Array.isArray(parsed[key])) return parsed[key]
        }
        const firstArr = Object.values(parsed || {}).find(Array.isArray)
        if (firstArr) return firstArr
        // Parsed but not an array — try next '['
        searchFrom = startIndex + 1
        continue
      } catch (e) {
        // Try recovery from this position first
        const recovered = this.#recoverPartialArray(cleaned.slice(startIndex))
        if (recovered.length > 0) {
          console.warn(`[#parseJSONArray] Recovered ${recovered.length} items from truncated response`)
          return recovered
        }
        // This '[' is not a JSON array — try next one
        searchFrom = startIndex + 1
        if (cleaned.indexOf("[", searchFrom) === -1) {
          console.error("[#parseJSONArray] Failed to parse JSON:")
          console.error("JSON string (first 500 chars):", jsonStr.slice(0, 500))
          throw new Error(`${this.name}: invalid JSON - ${e.message}`, { cause: e })
        }
      }
    }
  }

  #recoverPartialArray(str) {
    const results = []
    let i = str.indexOf("[")
    if (i === -1) return results
    i++
    while (i < str.length) {
      while (i < str.length && /[\s,]/.test(str[i])) i++
      if (i >= str.length || str[i] === "]") break
      if (str[i] !== "{") break
      let depth = 0
      const start = i
      for (; i < str.length; i++) {
        if (str[i] === "{") depth++
        else if (str[i] === "}") { depth--; if (depth === 0) { i++; break } }
      }
      try { results.push(JSON.parse(str.slice(start, i))) } catch {}
    }
    return results
  }

  /**
   * Parse JSON object from response.
   * @protected
   */
  #parseJSONObject(raw) {
    const cleaned = raw.replace(/```\w*\n?/g, "").trim()

    console.log("[#parseJSONObject] Raw response (first 200 chars):", raw.slice(0, 200))
    console.log("[#parseJSONObject] Cleaned (first 200 chars):", cleaned.slice(0, 200))

    // Find first [ or { — whichever comes first
    const arrayStart = cleaned.indexOf("[")
    const objectStart = cleaned.indexOf("{")
    
    let startIndex = -1
    let endIndex = -1
    let isArray = false

    // Determine which comes first
    if (arrayStart >= 0 && (objectStart === -1 || arrayStart <= objectStart)) {
      startIndex = arrayStart
      // Find the matching closing ] by counting brackets
      let depth = 0
      endIndex = -1
      for (let i = startIndex; i < cleaned.length; i++) {
        if (cleaned[i] === "[") depth++
        else if (cleaned[i] === "]") {
          depth--
          if (depth === 0) {
            endIndex = i
            break
          }
        }
      }
      isArray = true
    } else if (objectStart >= 0) {
      startIndex = objectStart
      // Find the matching closing } by counting braces
      let depth = 0
      endIndex = -1
      for (let i = startIndex; i < cleaned.length; i++) {
        if (cleaned[i] === "{") depth++
        else if (cleaned[i] === "}") {
          depth--
          if (depth === 0) {
            endIndex = i
            break
          }
        }
      }
      isArray = false
    }

    let jsonStr = cleaned
    if (startIndex >= 0 && endIndex > startIndex) {
      jsonStr = cleaned.slice(startIndex, endIndex + 1)
    }

    console.log("[#parseJSONObject] Extracted JSON (first 200 chars):", jsonStr.slice(0, 200))
    console.log("[#parseJSONObject] Is array:", isArray, "Start:", startIndex, "End:", endIndex)

    try {
      return JSON.parse(jsonStr)
    } catch (e) {
      console.error("[#parseJSONObject] Failed to parse JSON:")
      console.error("Full extracted string:", jsonStr)
      throw new Error(`${this.name}: invalid JSON - ${e.message}`, { cause: e })
    }
  }

  /**
   * Splits posts into batches whose rendered prompt stays within the token budget.
   * @private
   */
  #splitIntoBatches(list, buildPrompt) {
    const budgetChars = LIMITS.RANK_BATCH_TOKENS * LIMITS.CHARS_PER_TOKEN
    const overhead = buildPrompt([]).length
    const costOf = (item) => JSON.stringify(item).length + 2

    const batches = []
    let current = []
    let size = overhead

    for (const item of list) {
      const cost = costOf(item)
      if (current.length > 0 && size + cost > budgetChars) {
        batches.push(current)
        current = []
        size = overhead
      }
      current.push(item)
      size += cost
    }
    if (current.length > 0) batches.push(current)

    return batches
  }

  async rankPosts(posts, userProfile = "", _options = {}) {
    if (posts.length === 0) return []

    const { onProgress, systemPrompt } = _options
    if (typeof onProgress === "function") onProgress(10)

    const list = posts.map((p) => ({
      id: p.id,
      channel: p.channel,
      text: (p.text || "").slice(0, LIMITS.RANK_TEXT)
    }))

    const channelPriorities = _options.channelPriorities || {}
    const importantChannels = Object.entries(channelPriorities)
      .filter(([, p]) => p === 2)
      .map(([ch]) => ch)
      .join(", ")

    const feedback = _options.feedback || {}
    const liked = feedback.liked || []
    const disliked = feedback.disliked || []

    const buildPrompt = (items) =>
      buildRankPrompt(items, userProfile, importantChannels, liked, disliked, systemPrompt || null)

    const batches = this.#splitIntoBatches(list, buildPrompt)
    console.log(`[rankPosts] ${list.length} posts split into ${batches.length} request(s)`)

    const parsed = []
    for (let i = 0; i < batches.length; i++) {
      const raw = await this._callAPI(buildPrompt(batches[i]), { type: "json_object", maxTokens: 16384 })
      parsed.push(...this.#parseJSONArray(raw))
      if (typeof onProgress === "function") {
        onProgress(Math.round(((i + 1) / batches.length) * 100))
      }
    }

    console.log(`[rankPosts] AI returned ${parsed.length} items, sample: ${JSON.stringify(parsed.slice(0, 2))}`)

    return parsed.map((item) => ({
      post_id: String(item.post_id || item.id),
      score: Number(item.score) || 0,
      reason: String(item.reason || "")
    }))
  }

  async generateSummaryBlocks(posts, dateLabel, userProfile = "", maxItems = 10, _options = {}) {
    if (posts.length === 0) return { teaser: null, blocks: [] }

    const { onProgress, systemPrompt } = _options
    if (typeof onProgress === "function") onProgress(10)

    const list = posts.map((p) => ({
      id: p.id,
      channel: p.channel,
      post_id: p.post_id,
      text: (p.text || "").slice(0, LIMITS.SUMMARY_TEXT),
      link: p.link
    }))

    const maxBlocks = Math.min(LIMITS.MAX_BLOCKS, Math.max(LIMITS.MIN_BLOCKS, maxItems))
    const prompt = buildSummaryPrompt(list, dateLabel, userProfile, maxBlocks, systemPrompt || null)

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

  async analyzeChannel(posts, channel, userProfile = "", systemPrompt = null) {
    const list = posts.map((p) => ({
      text: (p.text || "").slice(0, LIMITS.ANALYZE_TEXT),
      link: p.link
    }))

    const prompt = buildAnalyzeChannelPrompt(channel, userProfile, list, systemPrompt)
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

  async auditAllChannels(channelsData, userProfile = "", _options = {}) {
    if (channelsData.length === 0) return []

    const { onProgress, systemPrompt } = _options
    const BATCH_SIZE = 7
    const batches = []

    // Split into batches of 7 channels (reduced to avoid JSON parsing errors)
    for (let i = 0; i < channelsData.length; i += BATCH_SIZE) {
      batches.push(channelsData.slice(i, i + BATCH_SIZE))
    }

    const allResults = []
    let completedBatches = 0

    // Process each batch
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
        const prompt = buildAuditAllChannelsPrompt(userProfile, list, systemPrompt || null)
        console.log(`[auditAllChannels] Processing batch: ${batch.length} channels, prompt length: ${prompt.length}`)
        const raw = await this._callAPI(prompt, { type: "json_object", maxTokens: 3072 })
        console.log("[auditAllChannels] Raw response (first 300 chars):", raw.slice(0, 300))
        const parsed = this.#parseJSONObject(raw)
        console.log("[auditAllChannels] Parsed channels:", Array.isArray(parsed) ? parsed.length : (parsed.channels?.length || 0))
        const batchResults = Array.isArray(parsed) ? parsed : (parsed.channels || [])
        allResults.push(...batchResults)
      } catch (e) {
        console.warn(`[auditAllChannels] Batch failed for ${batch.length} channels:`, e.message)
        console.error("Full error:", e)
        // Fallback for this batch
        for (const cd of batch) {
          const postCount = cd.posts.length || 1
          const totalViews = cd.posts.reduce((sum, p) => sum + (p.views || 0), 0) || 0
          allResults.push({
            channel: cd.channel,
            score: 0,
            avg_views: Math.round(totalViews / postCount),
            verdict: "mute",
            summary: "No data (AI unavailable)",
            reason: "Failed to get AI score",
            problem_type: "none",
            recommendation: "remove"
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
          summary: item.summary ? String(item.summary).trim().slice(0, 200) : "No description",
          reason: item.reason ? String(item.reason).trim().slice(0, 350) : "No explanation",
          problemType: ["irrelevant", "low_quality", "too_basic", "promo", "low_frequency", "none"].includes(item.problem_type) ? item.problem_type : "none",
          scoreBreakdown: { quality: 0.5, relevance: 0.5, spamFree: 1.0 },
          recommendation: ["remove", "keep", "keep_if", "mute"].includes(item.recommendation) ? item.recommendation : "remove",
          keepIfCondition: ""
        }
      })
      .sort((a, b) => b.score - a.score)
  }

  async recommendChannels(userProfile, _channelUsernames, systemPrompt = null) {
    if (!_channelUsernames?.length) return []

    const list = _channelUsernames.slice(0, LIMITS.MAX_CHANNELS_ANALYZE)
    const prompt = buildRecommendChannelsPrompt(userProfile, list, systemPrompt)

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

  async _callAPI(_prompt, _options) {
    throw new Error("Method '_callAPI()' must be implemented")
  }

  toString() {
    return this.name
  }
}
