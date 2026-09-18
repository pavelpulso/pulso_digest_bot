import { BaseAI } from "./BaseAI.js"
import { postJson } from "./http.js"

/**
 * CLIProxyAPI provider — OpenAI-compatible gateway over CLI subscriptions
 * (Gemini CLI, Codex, Claude Code, Qwen Code). Self-hosted.
 * Used for the Pro-class models the free tiers cannot reach.
 */
export class CliProxyAI extends BaseAI {
  constructor(config = {}) {
    super("CliProxy", { requestBudgetTokens: 60000, completionTokensPerPost: 400, completionTokensPerBlock: 700 })
    this.apiKey = config.apiKey ?? process.env.CLIPROXY_API_KEY ?? ""
    this.model = config.model ?? process.env.CLIPROXY_MODEL ?? ""
    this.baseUrl = this.#endpointFrom(config.baseUrl ?? process.env.CLIPROXY_BASE_URL ?? "")
    this.timeoutMs = config.timeoutMs
  }

  #endpointFrom(raw) {
    const base = raw.replace(/\/$/, "")
    if (!base) return ""
    return /\/chat\/completions$/.test(base) ? base : `${base}/v1/chat/completions`
  }

  async isReady() {
    return !!(this.baseUrl && this.model)
  }

  async _callAPI(prompt, options = {}) {
    if (!this.baseUrl || !this.model) {
      throw new Error("CLIPROXY_BASE_URL and CLIPROXY_MODEL must be set")
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
    if (text == null) throw new Error("CliProxy API: empty response")
    return text
  }
}
