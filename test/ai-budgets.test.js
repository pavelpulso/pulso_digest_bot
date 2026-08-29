import { test } from "node:test"
import assert from "node:assert/strict"
import { BaseAI } from "../src/ai/BaseAI.js"
import { GroqAI } from "../src/ai/GroqAI.js"
import { GeminiAI } from "../src/ai/GeminiAI.js"
import { withServer } from "./helpers.js"

class RecordingAI extends BaseAI {
	constructor(budgets) {
		super("Recording", budgets)
		this.calls = []
	}

	async isReady() {
		return true
	}

	async _callAPI(prompt, options = {}) {
		this.calls.push({ prompt, options })
		const ids = [...prompt.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
		if (options.type === "json_object" && prompt.includes("teaser")) {
			return JSON.stringify({ teaser: "t", blocks: ids.map((id) => ({ ids: [id], essence: "e" })) })
		}
		return JSON.stringify(ids.map((id) => ({ post_id: id, score: 0.5, reason: "ok" })))
	}
}

const posts = Array.from({ length: 48 }, (_, i) => ({
	id: `p${i}`,
	channel: "somechannel",
	text: "ы".repeat(2000)
}))

test("a provider with room to spare is not batched as tightly as a cramped one", async () => {
	const cramped = new RecordingAI({ requestBudgetTokens: 5000, completionTokensPerPost: 120 })
	const roomy = new RecordingAI({ requestBudgetTokens: 60000, completionTokensPerPost: 400 })

	await cramped.rankPosts(posts, "профиль")
	await roomy.rankPosts(posts, "профиль")

	assert.ok(
		roomy.calls.length < cramped.calls.length,
		`a roomy budget should need fewer requests, got ${roomy.calls.length} vs ${cramped.calls.length}`
	)
})

test("Groq is budgeted for its 8000 TPM ceiling, Gemini for its far larger one", () => {
	const groq = new GroqAI({ apiKey: "k" })
	const gemini = new GeminiAI({ apiKey: "k", baseUrl: "https://example.invalid" })

	assert.ok(groq.requestBudgetTokens <= 8000, "Groq must stay under its per-minute ceiling")
	assert.ok(
		gemini.requestBudgetTokens > groq.requestBudgetTokens,
		"Gemini has a far larger quota and should not inherit Groq's thrift"
	)
})

test("Gemini asks for the least reasoning the model accepts, so thinking cannot eat the answer", async () => {
	let body = null

	await withServer(
		(req, res) => {
			let raw = ""
			req.on("data", (c) => { raw += c })
			req.on("end", () => {
				body = JSON.parse(raw)
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }))
			})
		},
		async (url) => {
			const ai = new GeminiAI({ baseUrl: url, apiKey: "k", model: "gemini-3.6-flash" })
			await ai.rankPosts([{ id: "1", channel: "c", text: "привет" }], "профиль")
			assert.equal(body.reasoning_effort, "low")
		}
	)
})

test("building the digest text reserves a completion budget too", async () => {
	const ai = new RecordingAI()

	await ai.generateSummaryBlocks(posts.slice(0, 14), "29 августа", "профиль", 7)

	for (const { options } of ai.calls) {
		assert.ok(options.maxTokens > 0, "the summary request must state how much answer it needs")
	}
})

test("a provider that spends tokens on thinking reserves more per digest block", async () => {
	const lean = new RecordingAI()
	const thinky = new RecordingAI({ completionTokensPerBlock: 700 })

	await lean.generateSummaryBlocks(posts.slice(0, 14), "29 августа", "профиль", 7)
	await thinky.generateSummaryBlocks(posts.slice(0, 14), "29 августа", "профиль", 7)

	assert.ok(
		thinky.calls[0].options.maxTokens > lean.calls[0].options.maxTokens,
		"the block reserve must follow the provider, not one global constant"
	)
	assert.ok(
		new GeminiAI({ baseUrl: "http://x", apiKey: "k" }).completionTokensPerBlock > new GroqAI({ apiKey: "k" }).completionTokensPerBlock,
		"Gemini burns reasoning tokens from the same ceiling and needs the larger reserve"
	)
})

test("compact digests do not pay for fields their rendering throws away", async () => {
	const full = new RecordingAI()
	const compact = new RecordingAI()

	await full.generateSummaryBlocks(posts.slice(0, 4), "29 августа", "профиль", 4)
	await compact.generateSummaryBlocks(posts.slice(0, 4), "29 августа", "профиль", 4, { compact: true })

	assert.ok(full.calls[0].prompt.includes("potential"), "the full format still asks for potential")
	assert.ok(!compact.calls[0].prompt.includes("• potential"), "compact must not ask for a field it never renders")
	assert.ok(!compact.calls[0].prompt.includes("• action"), "compact must not ask for an action it never renders")
})
