import { test } from "node:test"
import assert from "node:assert/strict"
import { BaseAI } from "../src/ai/BaseAI.js"
import { LIMITS } from "../src/ai/constants.js"

class RecordingAI extends BaseAI {
	constructor() {
		super("Recording")
		this.prompts = []
		this.calls = []
	}

	async isReady() {
		return true
	}

	async _callAPI(prompt, options = {}) {
		this.prompts.push(prompt)
		this.calls.push({ prompt, options })
		const ids = [...prompt.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
		return JSON.stringify(ids.map((id) => ({ post_id: id, score: 0.5, reason: "ok" })))
	}
}

function makePosts(count, textLength, char = "x") {
	return Array.from({ length: count }, (_, i) => ({
		id: `post-${i}`,
		channel: "somechannel",
		text: char.repeat(textLength)
	}))
}

test("a day too large for one request is ranked in several bounded requests", async () => {
	const ai = new RecordingAI()
	const posts = makePosts(200, 2000)

	const ranked = await ai.rankPosts(posts, "reader profile")

	assert.ok(ai.prompts.length > 1, `expected several requests, got ${ai.prompts.length}`)

	const budgetChars = LIMITS.RANK_BATCH_TOKENS * 4
	for (const prompt of ai.prompts) {
		assert.ok(
			prompt.length <= budgetChars,
			`a request of ${prompt.length} chars exceeds the ${budgetChars} char budget`
		)
	}

	const returnedIds = ranked.map((r) => r.post_id)
	assert.equal(new Set(returnedIds).size, 200, "every post is scored exactly once")
})

// Cyrillic costs roughly 2.5 characters per token, against ~4 for English.
const CYRILLIC_CHARS_PER_TOKEN = 2.5
const GROQ_TPM_LIMIT = 8000

test("every request of a Russian-language day stays under the free-tier per-request ceiling", async () => {
	const ai = new RecordingAI()
	const posts = makePosts(60, 2000, "ы")

	await ai.rankPosts(posts, "профиль читателя")

	assert.ok(ai.prompts.length > 1, "a full day cannot be one request")

	for (const prompt of ai.prompts) {
		const estimatedTokens = prompt.length / CYRILLIC_CHARS_PER_TOKEN
		assert.ok(
			estimatedTokens <= GROQ_TPM_LIMIT,
			`a request of ~${Math.round(estimatedTokens)} tokens exceeds the ${GROQ_TPM_LIMIT} limit`
		)
	}
})

test("a request reserves a completion budget sized to its batch, not a flat maximum", async () => {
	const ai = new RecordingAI()
	const posts = makePosts(48, 2000, "ы")

	await ai.rankPosts(posts, "профиль читателя")

	for (const { prompt, options } of ai.calls) {
		const promptTokens = prompt.length / CYRILLIC_CHARS_PER_TOKEN
		const reserved = options.maxTokens ?? 0
		assert.ok(
			promptTokens + reserved <= GROQ_TPM_LIMIT,
			`prompt ${Math.round(promptTokens)} + reserved ${reserved} exceeds the ${GROQ_TPM_LIMIT} limit`
		)
	}
})
