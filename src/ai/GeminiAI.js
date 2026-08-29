import { BaseAI } from "./BaseAI.js"
import { postJson } from "./http.js"

/**
 * Gemini AI provider via OpenAI-compatible proxy.
 */
export class GeminiAI extends BaseAI {
  constructor(config = {}) {
    super("Gemini")
    this.proxyUrl = (config.proxyUrl ?? process.env.GEMINI_PROXY_URL ?? "").replace(/\/$/, "")
    this.apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? ""
    this.model = config.model ?? process.env.GEMINI_MODEL ?? "gemini-2.0-flash"
  }

  async isReady() {
    return !!(this.proxyUrl && this.apiKey)
  }

  async _callAPI(prompt, options = {}) {
    if (!this.proxyUrl || !this.apiKey) {
      throw new Error("GEMINI_PROXY_URL and GEMINI_API_KEY must be set")
    }

    const body = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0,
      stream: false
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens

    const data = await postJson(`${this.proxyUrl}/openai/v1/chat/completions`, {
      apiKey: this.apiKey,
      body
    })

    const text = data.choices?.[0]?.message?.content
    if (text == null) throw new Error("Gemini API: empty response")
    return text
  }
}
