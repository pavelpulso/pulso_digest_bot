import { test } from "node:test"
import assert from "node:assert/strict"
import { BaseAI } from "../src/ai/BaseAI.js"
import { GroqAI } from "../src/ai/GroqAI.js"
import { GeminiAI } from "../src/ai/GeminiAI.js"
import { OpenRouterAI } from "../src/ai/OpenRouterAI.js"
import { LIMITS } from "../src/ai/constants.js"
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
	const lean = new RecordingAI({ completionTokensPerBlock: 220 }) // the old English-sized default
	const thinky = new RecordingAI({ completionTokensPerBlock: 700 })

	await lean.generateSummaryBlocks(posts.slice(0, 14), "29 августа", "профиль", 7)
	await thinky.generateSummaryBlocks(posts.slice(0, 14), "29 августа", "профиль", 7)

	assert.ok(
		thinky.calls[0].options.maxTokens > lean.calls[0].options.maxTokens,
		"the block reserve must follow the provider, not one global constant"
	)
	// Gemini and Groq's gpt-oss-120b are both reasoning models that spend part of the same
	// completion ceiling on chain-of-thought before the visible answer, so both need the same
	// large reserve — neither gets to keep the tight, word-cap-derived floor.
	assert.ok(
		new GeminiAI({ baseUrl: "http://x", apiKey: "k" }).completionTokensPerBlock >= 700,
		"Gemini burns reasoning tokens from the same ceiling and needs the larger reserve"
	)
	assert.ok(
		new GroqAI({ apiKey: "k" }).completionTokensPerBlock >= 700,
		"Groq's gpt-oss-120b is also a reasoning model and needs the same larger reserve"
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

// Word caps stated by the prompts (prompts.js buildSummaryPrompt / buildRankPrompt) give a
// THEORETICAL floor — a ranked post asks for a reason (RANK_REASON_WORDS) + a 1-2 word topic.
const POST_WORDS = LIMITS.RANK_REASON_WORDS + 2
const CHARS_PER_WORD = 15 // same conservative ratio as SUMMARY_WORDS truncation in BaseAI.js

function minPostTokens() {
	return Math.ceil((POST_WORDS * CHARS_PER_WORD + 60) / LIMITS.CHARS_PER_TOKEN)
}

// The block floor is NOT the word-cap arithmetic (that gives ~240, which is exactly the old
// default that truncated in production). Models don't respect the caps: OpenRouter was observed
// truncated at ~350 tokens for a single block of a 3-block reply (a CUT-OFF length, so the real
// answer needed more), a Gemini essence came back at 17 words against a 14-word cap, and
// reasoning models (Gemini, Groq's gpt-oss-120b, OpenRouter's nemotron-3-super) spend part of
// this same ceiling on chain-of-thought before the visible answer. 700 is the number already
// proven in production to stop Gemini's truncation — require every provider to match it.
const MIN_BLOCK_TOKENS_OBSERVED = 700

test("every provider's budget can actually fit what its prompt asks for", () => {
	const providers = [
		new GeminiAI({ apiKey: "k", baseUrl: "https://example.invalid" }),
		new GroqAI({ apiKey: "k" }),
		new OpenRouterAI({ apiKey: "k" })
	]

	const minPost = minPostTokens()

	for (const provider of providers) {
		assert.ok(
			provider.completionTokensPerBlock >= MIN_BLOCK_TOKENS_OBSERVED,
			`${provider.name}: completionTokensPerBlock (${provider.completionTokensPerBlock}) must cover observed truncation + reasoning headroom (>=${MIN_BLOCK_TOKENS_OBSERVED})`
		)
		assert.ok(
			provider.completionTokensPerPost >= minPost,
			`${provider.name}: completionTokensPerPost (${provider.completionTokensPerPost}) must cover a reason + topic (>=${minPost})`
		)
	}
})
