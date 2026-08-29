import { BaseAI } from "./BaseAI.js"
import { postJson } from "./http.js"

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

/**
 * Groq AI provider — ultra-fast inference on LPU.
 * Free tier limits: ~500K tokens/day.
 */
export class GroqAI extends BaseAI {
  constructor(config = {}) {
    super("Groq")
    this.apiKey = config.apiKey ?? process.env.GROQ_API_KEY ?? ""
    this.model = config.model ?? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile"
    this.baseUrl = config.baseUrl ?? GROQ_URL
    this.timeoutMs = config.timeoutMs
  }

  async isReady() {
    return !!(this.apiKey && this.model)
  }

  async _callAPI(prompt, options = {}) {
    if (!this.apiKey) {
      throw new Error("GROQ_API_KEY must be set")
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
      timeoutMs: this.timeoutMs
    })

    const text = data.choices?.[0]?.message?.content
    if (text == null) throw new Error("Groq API: empty response")
    return text
  }
}
