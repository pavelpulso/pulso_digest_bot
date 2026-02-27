import { BaseAI } from "./BaseAI.js"

const QWEN_WORKER_URL = process.env.QWEN_WORKER_URL || "https://qwen-worker-proxy.pullso-code.workers.dev/v1/chat/completions"
const QWEN_WORKER_MODEL_PLUS = process.env.QWEN_WORKER_MODEL_PLUS || process.env.QWEN_WORKER_MODEL || "qwen3-coder-plus"
const QWEN_WORKER_MODEL_FLASH = process.env.QWEN_WORKER_MODEL_FLASH || "qwen3-coder-flash"

/**
 * Qwen Worker Proxy — OpenAI-совместимый API.
 * Лимиты: 4000 запросов/сутки.
 * Модели:
 *   - qwen3-coder-plus (мощная) — для ранкинга, анализа каналов, аудита
 *   - qwen3-coder-flash (быстрая) — для генерации дайджестов
 */
export class QwenWorkerAI extends BaseAI {
  constructor(taskType = "auto") {
    super("QwenWorker")
    this.taskType = taskType
    this.model = this.#selectModel(taskType)
  }

  #selectModel(taskType) {
    // Используем plus для всех задач — качество важнее экономии
    // flash может хуже справляться с группировкой и формулировками
    return QWEN_WORKER_MODEL_PLUS
  }

  async isReady() {
    return !!(QWEN_WORKER_URL && QWEN_WORKER_MODEL_PLUS)
  }

  async _callAPI(prompt, options = {}) {
    if (!QWEN_WORKER_URL) {
      throw new Error("QWEN_WORKER_URL must be set")
    }

    const url = QWEN_WORKER_URL
    const modelToUse = options.model || this.model
    const body = {
      model: modelToUse,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0,
      stream: false
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens
    if (options.responseFormat) body.response_format = options.responseFormat

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Qwen Worker API ${res.status}: ${errText}`)
    }

    const data = await res.json()
    const text = data.choices?.[0]?.message?.content
    if (text == null) throw new Error("Qwen Worker API: empty response")
    return text
  }
}
