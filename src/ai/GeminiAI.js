import { BaseAI } from "./BaseAI.js"

const GEMINI_PROXY_URL = (process.env.GEMINI_PROXY_URL || "").replace(/\/$/, "")
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash"

/**
 * Gemini AI провайдер через OpenAI-совместимый прокси.
 */
export class GeminiAI extends BaseAI {
  constructor() {
    super("Gemini")
  }

  async isReady() {
    return !!(GEMINI_PROXY_URL && GEMINI_API_KEY)
  }

  async _callAPI(prompt, options = {}) {
    if (!GEMINI_PROXY_URL || !GEMINI_API_KEY) {
      throw new Error("GEMINI_PROXY_URL and GEMINI_API_KEY must be set")
    }

    const url = `${GEMINI_PROXY_URL}/openai/v1/chat/completions`
    const body = {
      model: GEMINI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0,
      stream: false
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens
    if (options.responseFormat) body.response_format = options.responseFormat

    return this.#chatWithRetry(url, GEMINI_API_KEY, body)
  }

  async #chatWithRetry(url, apiKey, body, maxRetries = 3) {
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
          const waitMs = 1000 * attempt
          console.log(`[Gemini] 429 Too Many Requests. Retry ${attempt}/${maxRetries} after ${waitMs}ms`)
          await new Promise(r => setTimeout(r, waitMs))
          continue
        }
        if (!res.ok) {
          const errText = await res.text()
          throw new Error(`Gemini API ${res.status}: ${errText}`)
        }
        const data = await res.json()
        const text = data.choices?.[0]?.message?.content
        if (text == null) throw new Error("Gemini API: empty response")
        return text
      } catch (e) {
        if (e.message.includes("429") && attempt < maxRetries) {
          lastError = e
          continue
        }
        throw e
      }
    }
    throw lastError || new Error("Gemini API: max retries exceeded")
  }
}
