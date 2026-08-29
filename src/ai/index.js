import { GeminiAI } from "./GeminiAI.js"
import { GroqAI } from "./GroqAI.js"
import { OpenRouterAI } from "./OpenRouterAI.js"
import { QwenWorkerAI } from "./QwenWorkerAI.js"

const AI_PROVIDER = (process.env.AI_PROVIDER || "auto").toLowerCase()
const COOLDOWN_MS = parseInt(process.env.AI_COOLDOWN_MS, 10) || 15 * 60 * 1000

/**
 * AI router with automatic fallback.
 * Provider order: Gemini → QwenWorker → Groq → OpenRouter
 */
export class AIRouter {
  constructor(options = {}) {
    this.providers = options.providers || this.#initProviders()
    this.currentProvider = null
    this.initialized = false
    this.now = options.now || (() => Date.now())
    this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS
    this.coolingUntil = new Map()
  }

  #isCooling(provider) {
    const until = this.coolingUntil.get(provider)
    return until != null && until > this.now()
  }

  #startCooldown(provider) {
    this.coolingUntil.set(provider, this.now() + this.cooldownMs)
  }

  #initProviders() {
    const all = [new GeminiAI(), new QwenWorkerAI(), new GroqAI(), new OpenRouterAI()]
    if (AI_PROVIDER === "auto") return all
    if (AI_PROVIDER === "gemini") return [new GeminiAI()]
    if (AI_PROVIDER === "groq") return [new GroqAI()]
    if (AI_PROVIDER === "openrouter") return [new OpenRouterAI()]
    if (AI_PROVIDER === "qwen-worker") return [new QwenWorkerAI()]
    console.warn(`[AI] Unknown AI_PROVIDER="${AI_PROVIDER}", using auto fallback`)
    return all
  }

  async init() {
    if (this.initialized) return

    for (const provider of this.providers) {
      try {
        if (await provider.isReady()) {
          this.currentProvider = provider
          console.log(`[AI] Using provider: ${provider.toString()}`)
          this.initialized = true
          return
        }
      } catch (e) {
        console.warn(`[AI] Provider ${provider.toString()} not ready:`, e.message)
      }
    }

    throw new Error("No AI providers available. Set API keys in .env")
  }

  async #executeWithFallback(methodName, args, taskType = null, startWithQwen = false) {
    if (!this.initialized) await this.init()

    const providersToTry = this.#getProvidersOrder(taskType, startWithQwen)
    const failures = []
    const tried = new Set()

    for (const provider of providersToTry) {
      if (tried.has(provider)) continue
      tried.add(provider)

      const result = await this.#tryProvider(provider, methodName, args, taskType, failures)
      if (result !== null) return result
    }

    const detail = failures.map((f) => `${f.provider}: ${f.message}`).join("; ")
    throw new Error(`All AI providers failed for ${methodName} — ${detail}`)
  }

  #getProvidersOrder(taskType, startWithQwen = false) {
    // For audit, start with Qwen (more stable with JSON arrays)
    if (startWithQwen) {
      const qwen = this.providers.find(p => p.toString() === "QwenWorker")
      const others = this.providers.filter(p => p.toString() !== "QwenWorker")
      return qwen ? [qwen, ...others] : this.providers
    }
    const ordered = this.currentProvider
      ? [this.currentProvider, ...this.providers.filter(p => p !== this.currentProvider)]
      : this.providers

    const usable = ordered.filter(p => !this.#isCooling(p))
    return usable.length > 0 ? usable : ordered
  }

  async #tryProvider(provider, methodName, args, taskType, failures = []) {
    try {
      if (!(await provider.isReady())) {
        console.warn(`[AI] Provider ${provider.toString()} not ready, skipping`)
        failures.push({ provider: provider.toString(), message: "not ready" })
        this.#startCooldown(provider)
        return null
      }

      if (this.#isCooling(provider)) {
        failures.push({ provider: provider.toString(), message: "cooling down after a recent failure" })
        return null
      }

      const method = provider[methodName]
      if (typeof method !== "function") {
        throw new Error(`Method ${methodName} not implemented on ${provider.toString()}`)
      }

      const result = await method.apply(provider, args)

      this.coolingUntil.delete(provider)

      if (this.currentProvider !== provider) {
        console.log(`[AI] Switched to provider: ${provider.toString()}`)
        this.currentProvider = provider
      }

      return result
    } catch (e) {
      console.warn(`[AI] Provider ${provider.toString()} failed:`, e.message)
      failures.push({ provider: provider.toString(), message: e.message })
      this.#startCooldown(provider)
      return null
    }
  }

  rankPosts(posts, userProfile, options) {
    return this.#executeWithFallback("rankPosts", [posts, userProfile, options || {}], "rank")
  }

  generateSummaryBlocks(posts, dateLabel, userProfile, maxItems, options) {
    return this.#executeWithFallback("generateSummaryBlocks", [posts, dateLabel, userProfile, maxItems, options || {}], "summary")
  }

  analyzeChannel(posts, channelName, userProfile, systemPrompt) {
    return this.#executeWithFallback("analyzeChannel", [posts, channelName, userProfile, systemPrompt], "analyze")
  }

  auditAllChannels(channelsData, userProfile, options) {
    return this.#executeWithFallback("auditAllChannels", [channelsData, userProfile, options || {}], "audit")
  }

  recommendChannels(userProfile, channelUsernames, systemPrompt) {
    return this.#executeWithFallback("recommendChannels", [userProfile, channelUsernames, systemPrompt], "recommend")
  }

  getCurrentProvider() {
    return this.currentProvider
  }

  getAvailableProviders() {
    return this.providers.map(p => ({
      name: p.toString(),
      isCurrent: p === this.currentProvider
    }))
  }
}

const router = new AIRouter()

const autoInit = async () => {
  try {
    await router.init()
  } catch (e) {
    console.warn("[AI] Auto-init failed:", e.message)
  }
}

export const rankPosts = (...args) => router.rankPosts(...args)
export const generateSummaryBlocks = (...args) => router.generateSummaryBlocks(...args)
export const analyzeChannel = (...args) => router.analyzeChannel(...args)
export const auditAllChannels = (...args) => router.auditAllChannels(...args)
export const recommendChannels = (...args) => router.recommendChannels(...args)
export { router, autoInit }
export default router
