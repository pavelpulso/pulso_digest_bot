import { BaseAI } from "./BaseAI.js"

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ""
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free"
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || ""
const OPENROUTER_SITE_NAME = process.env.OPENROUTER_SITE_NAME || ""

/**
 * OpenRouter provider — 29+ free models.
 * Free tier limits: 200 requests/day, 20 RPM per model.
 */
export class OpenRouterAI extends BaseAI {
  constructor() {
    super("OpenRouter")
  }

  async isReady() {
    return !!(OPENROUTER_API_KEY && OPENROUTER_MODEL)
  }

  async _callAPI(prompt, options = {}) {
    if (!OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY must be set")
    }

    const url = "https://openrouter.ai/api/v1/chat/completions"
    const body = {
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0,
      stream: false
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens
    if (options.responseFormat) body.response_format = options.responseFormat

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": OPENROUTER_SITE_URL,
      "X-Title": OPENROUTER_SITE_NAME
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`OpenRouter API ${res.status}: ${errText}`)
    }

    const data = await res.json()
    const text = data.choices?.[0]?.message?.content
    if (text == null) throw new Error("OpenRouter API: empty response")
    return text
  }
}
