import { test } from "node:test"
import assert from "node:assert/strict"
import { AIRouter } from "../src/ai/index.js"

function makeProvider(name, impl) {
	return {
		toString: () => name,
		isReady: async () => true,
		rankPosts: async (...args) => impl(...args)
	}
}

test("failure of every provider reports each provider's own error", async () => {
	const providers = [
		makeProvider("Alpha", () => { throw new Error("quota exceeded") }),
		makeProvider("Beta", () => { throw new Error("502 bad gateway") })
	]
	const router = new AIRouter({ providers })

	await assert.rejects(
		() => router.rankPosts([{ id: "1" }], ""),
		(err) => {
			assert.match(err.message, /Alpha: quota exceeded/)
			assert.match(err.message, /Beta: 502 bad gateway/)
			return true
		}
	)
})

test("a provider that failed is not retried until its cooldown expires", async () => {
	const calls = { Alpha: 0, Beta: 0 }
	let betaFails = false
	let clock = 1_000_000

	const providers = [
		makeProvider("Alpha", () => {
			calls.Alpha++
			throw new Error("429 quota exceeded")
		}),
		makeProvider("Beta", () => {
			calls.Beta++
			if (betaFails) throw new Error("502 bad gateway")
			return [{ post_id: "1", score: 5, reason: "" }]
		})
	]
	const router = new AIRouter({ providers, now: () => clock, cooldownMs: 60_000 })

	await router.rankPosts([{ id: "1" }], "")
	assert.equal(calls.Alpha, 1, "Alpha is tried on the first call")

	betaFails = true
	clock += 30_000
	await assert.rejects(() => router.rankPosts([{ id: "1" }], ""))
	assert.equal(calls.Alpha, 1, "Alpha is still cooling and must not be hit again")

	clock += 40_000
	await assert.rejects(() => router.rankPosts([{ id: "1" }], ""))
	assert.equal(calls.Alpha, 2, "cooldown expired, Alpha is tried again")
})
