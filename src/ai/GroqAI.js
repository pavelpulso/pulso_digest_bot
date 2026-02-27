import { BaseAI } from "./BaseAI.js"

const GROQ_API_KEY = process.env.GROQ_API_KEY || ""
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile"

/**
 * Groq AI провайдер — сверхбыстрый инференс на LPU.
 * Лимиты free tier: ~500K токенов/день.
 */
export class GroqAI extends BaseAI {
  constructor() {
    super("Groq")
  }

  async isReady() {
    return !!(GROQ_API_KEY && GROQ_MODEL)
  }

  async _callAPI(prompt, options = {}) {
    if (!GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY must be set")
    }

    const url = "https://api.groq.com/openai/v1/chat/completions"
    const body = {
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0,
      stream: false
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens
    if (options.responseFormat) body.response_format = options.responseFormat

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Groq API ${res.status}: ${errText}`)
    }

    const data = await res.json()
    const text = data.choices?.[0]?.message?.content
    if (text == null) throw new Error("Groq API: empty response")
    return text
  }
}
