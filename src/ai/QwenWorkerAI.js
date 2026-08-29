import { BaseAI } from "./BaseAI.js"
import { postJson } from "./http.js"

const QWEN_WORKER_URL = "https://qwen-worker-proxy.pullso-code.workers.dev/v1/chat/completions"

/**
 * Qwen Worker Proxy — OpenAI-compatible API.
 * Limit: 4000 requests/day.
 */
export class QwenWorkerAI extends BaseAI {
  constructor(config = {}) {
    super("QwenWorker")
    this.baseUrl = config.baseUrl ?? process.env.QWEN_WORKER_URL ?? QWEN_WORKER_URL
    this.model = config.model
      ?? process.env.QWEN_WORKER_MODEL_PLUS
      ?? process.env.QWEN_WORKER_MODEL
      ?? "qwen3-coder-plus"
    this.timeoutMs = config.timeoutMs
  }

  async isReady() {
    return !!(this.baseUrl && this.model)
  }

  async _callAPI(prompt, options = {}) {
    if (!this.baseUrl) {
      throw new Error("QWEN_WORKER_URL must be set")
    }

    const body = {
      model: options.model || this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0,
      stream: false
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens
    if (options.responseFormat) body.response_format = options.responseFormat

    const data = await postJson(this.baseUrl, {
      body,
      timeoutMs: this.timeoutMs
    })

    const text = data.choices?.[0]?.message?.content
    if (text == null) throw new Error("Qwen Worker API: empty response")
    return text
  }
}
