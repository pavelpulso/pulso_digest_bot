import { BaseAI } from "./BaseAI.js"
import { postJson } from "./http.js"

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

/**
 * OpenRouter provider — 29+ free models.
 * Free tier limits: 200 requests/day, 20 RPM per model.
 */
export class OpenRouterAI extends BaseAI {
  constructor(config = {}) {
    super("OpenRouter")
    this.apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY ?? ""
    this.model = config.model ?? process.env.OPENROUTER_MODEL ?? "google/gemma-4-31b-it:free"
    this.baseUrl = config.baseUrl ?? OPENROUTER_URL
    this.timeoutMs = config.timeoutMs
    this.siteUrl = config.siteUrl ?? process.env.OPENROUTER_SITE_URL ?? ""
    this.siteName = config.siteName ?? process.env.OPENROUTER_SITE_NAME ?? ""
  }

  async isReady() {
    return !!(this.apiKey && this.model)
  }

  async _callAPI(prompt, options = {}) {
    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY must be set")
    }

    const body = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0,
      stream: false
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens
    if (options.responseFormat) body.response_format = options.responseFormat

    const data = await postJson(this.baseUrl, {
      apiKey: this.apiKey,
      body,
      timeoutMs: this.timeoutMs,
      headers: {
        "HTTP-Referer": this.siteUrl,
        "X-Title": this.siteName
      }
    })

    const text = data.choices?.[0]?.message?.content
    if (text == null) throw new Error("OpenRouter API: empty response")
    return text
  }
}
