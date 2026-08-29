import { test } from "node:test"
import assert from "node:assert/strict"
import { GroqAI } from "../src/ai/GroqAI.js"
import { OpenRouterAI } from "../src/ai/OpenRouterAI.js"
import { withServer } from "./helpers.js"

const providers = [
	["Groq", (url) => new GroqAI({ apiKey: "k", baseUrl: url, timeoutMs: 150 })],
	["OpenRouter", (url) => new OpenRouterAI({ apiKey: "k", baseUrl: url, timeoutMs: 150 })]
]

for (const [name, build] of providers) {
	test(`${name} aborts a hanging endpoint instead of waiting forever`, async () => {
		await withServer(
			() => {},
			async (url) => {
				const ai = build(url)
				await assert.rejects(
					() => ai.rankPosts([{ id: "1", channel: "c", text: "hello" }], ""),
					(err) => {
						assert.match(err.message, /timed out after 150ms/)
						return true
					}
				)
			}
		)
	})
}
