import { BaseAI } from "./BaseAI.js"
import { postJson } from "./http.js"

/**
 * Gemini AI provider via OpenAI-compatible proxy.
 */
export class GeminiAI extends BaseAI {
  constructor(config = {}) {
    super("Gemini", { requestBudgetTokens: 60000, completionTokensPerPost: 400 })
    this.proxyUrl = (config.proxyUrl ?? process.env.GEMINI_PROXY_URL ?? "").replace(/\/$/, "")
    this.baseUrl = config.baseUrl ?? process.env.GEMINI_BASE_URL ?? ""
    this.apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? ""
    this.model = config.model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash"
    this.timeoutMs = config.timeoutMs
  }

  #endpoint() {
    return this.baseUrl || (this.proxyUrl && `${this.proxyUrl}/openai/v1/chat/completions`)
  }

  async isReady() {
    return !!(this.#endpoint() && this.apiKey)
  }

  async _callAPI(prompt, options = {}) {
    const endpoint = this.#endpoint()
    if (!endpoint || !this.apiKey) {
      throw new Error("GEMINI_BASE_URL (or GEMINI_PROXY_URL) and GEMINI_API_KEY must be set")
    }

    const body = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0,
      stream: false,
      reasoning_effort: "none"
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens

    const data = await postJson(endpoint, {
      apiKey: this.apiKey,
      body,
      timeoutMs: this.timeoutMs
    })

    const text = data.choices?.[0]?.message?.content
    if (text == null) throw new Error("Gemini API: empty response")
    return text
  }
}
