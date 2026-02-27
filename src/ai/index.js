import { GeminiAI } from "./GeminiAI.js"
import { GroqAI } from "./GroqAI.js"
import { OpenRouterAI } from "./OpenRouterAI.js"

const AI_PROVIDER = (process.env.AI_PROVIDER || "auto").toLowerCase()

/**
 * AI роутер с автоматическим fallback.
 * Порядок переключения: Gemini → Groq → OpenRouter
 */
class AIRouter {
  constructor() {
    this.providers = this.#initProviders()
    this.currentProvider = null
    this.initialized = false
  }

  #initProviders() {
    const all = [new GeminiAI(), new GroqAI(), new OpenRouterAI()]
    if (AI_PROVIDER === "auto") return all
    if (AI_PROVIDER === "gemini") return [new GeminiAI()]
    if (AI_PROVIDER === "groq") return [new GroqAI()]
    if (AI_PROVIDER === "openrouter") return [new OpenRouterAI()]
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

  async #executeWithFallback(methodName, args) {
    if (!this.initialized) await this.init()

    const providersToTry = this.#getProvidersOrder()
    const lastError = null
    const tried = new Set()

    for (const provider of providersToTry) {
      if (tried.has(provider)) continue
      tried.add(provider)

      const result = await this.#tryProvider(provider, methodName, args)
      if (result !== null) return result
    }

    throw lastError || new Error("All AI providers failed")
  }

  #getProvidersOrder() {
    if (!this.currentProvider) return this.providers
    const others = this.providers.filter(p => p !== this.currentProvider)
    return [this.currentProvider, ...others]
  }

  async #tryProvider(provider, methodName, args) {
    try {
      if (!(await provider.isReady())) {
        console.warn(`[AI] Provider ${provider.toString()} not ready, skipping`)
        return null
      }

      const method = provider[methodName]
      if (typeof method !== "function") {
        throw new Error(`Method ${methodName} not implemented on ${provider.toString()}`)
      }

      const result = await method.apply(provider, args)

      if (this.currentProvider !== provider) {
        console.log(`[AI] Switched to provider: ${provider.toString()}`)
        this.currentProvider = provider
      }

      return result
    } catch (e) {
      console.warn(`[AI] Provider ${provider.toString()} failed:`, e.message)
      return null
    }
  }

  rankPosts(posts, userProfile, options) {
    return this.#executeWithFallback("rankPosts", [posts, userProfile, options])
  }

  generateSummaryBlocks(posts, dateLabel, userProfile, maxItems, options) {
    return this.#executeWithFallback("generateSummaryBlocks", [posts, dateLabel, userProfile, maxItems, options])
  }

  analyzeChannel(posts, channelName, userProfile) {
    return this.#executeWithFallback("analyzeChannel", [posts, channelName, userProfile])
  }

  auditAllChannels(channelsData, userProfile) {
    return this.#executeWithFallback("auditAllChannels", [channelsData, userProfile])
  }

  recommendChannels(userProfile, channelUsernames) {
    return this.#executeWithFallback("recommendChannels", [userProfile, channelUsernames])
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
