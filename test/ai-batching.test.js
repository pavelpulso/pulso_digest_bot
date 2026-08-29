import { test } from "node:test"
import assert from "node:assert/strict"
import { BaseAI } from "../src/ai/BaseAI.js"
import { LIMITS } from "../src/ai/constants.js"

class RecordingAI extends BaseAI {
	constructor() {
		super("Recording")
		this.prompts = []
	}

	async isReady() {
		return true
	}

	async _callAPI(prompt) {
		this.prompts.push(prompt)
		const ids = [...prompt.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
		return JSON.stringify(ids.map((id) => ({ post_id: id, score: 0.5, reason: "ok" })))
	}
}

function makePosts(count, textLength) {
	return Array.from({ length: count }, (_, i) => ({
		id: `post-${i}`,
		channel: "somechannel",
		text: "x".repeat(textLength)
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

test("a typical day of 60 posts fits into at most two requests", async () => {
	const ai = new RecordingAI()
	const posts = makePosts(60, 2000)

	await ai.rankPosts(posts, "reader profile")

	assert.ok(
		ai.prompts.length <= 2,
		`a normal day should cost at most 2 requests, took ${ai.prompts.length}`
	)
})
