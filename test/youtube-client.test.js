import { test } from "node:test"
import assert from "node:assert/strict"
import { withServer } from "./helpers.js"
import { YouTubeClient } from "../src/youtube/client.js"

function makeClient(url, overrides = {}) {
	return new YouTubeClient({
		clientId: "cid",
		clientSecret: "secret",
		refreshToken: "refresh",
		baseUrl: url,
		oauthUrl: `${url}token`,
		timeoutMs: 2000,
		...overrides
	})
}

test("120 video ids go out as three requests, not 120", async () => {
	const seenBatches = []

	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			if (url.pathname.endsWith("/token")) {
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }))
			}
			const ids = (url.searchParams.get("id") || "").split(",").filter(Boolean)
			seenBatches.push(ids.length)
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({
				items: ids.map((id) => ({
					id,
					snippet: { title: "t", description: "d", publishedAt: "2026-08-29T10:00:00Z", channelTitle: "c" },
					statistics: { viewCount: "100" },
					contentDetails: { duration: "PT10M" }
				}))
			}))
		},
		async (url) => {
			const client = makeClient(url)
			const ids = Array.from({ length: 120 }, (_, i) => `video${i}`)
			const details = await client.listVideoDetails(ids)
			assert.deepEqual(seenBatches, [50, 50, 20])
			assert.equal(details.length, 120)
			assert.equal(details[0].durationSec, 600)
			assert.equal(details[0].views, 100)
		}
	)
})

test("the access token is fetched once and reused until it expires", async () => {
	let tokenCalls = 0

	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			if (url.pathname.endsWith("/token")) {
				tokenCalls++
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }))
			}
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ items: [] }))
		},
		async (url) => {
			const client = makeClient(url)
			await client.listVideoDetails(["a"])
			await client.listVideoDetails(["b"])
			assert.equal(tokenCalls, 1, "a valid token must not be re-fetched per request")
		}
	)
})

test("an exhausted quota is not retried", async () => {
	let apiCalls = 0

	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			if (url.pathname.endsWith("/token")) {
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }))
			}
			apiCalls++
			res.writeHead(403, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }))
		},
		async (url) => {
			const client = makeClient(url)
			await assert.rejects(() => client.listVideoDetails(["a"]), /quota/i)
			assert.equal(apiCalls, 1, "a daily quota does not come back from a retry")
		}
	)
})

test("subscriptions are paged until nextPageToken runs out", async () => {
	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			if (url.pathname.endsWith("/token")) {
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }))
			}
			const pageToken = url.searchParams.get("pageToken")
			res.writeHead(200, { "Content-Type": "application/json" })
			if (!pageToken) {
				return res.end(JSON.stringify({
					nextPageToken: "page2",
					items: [{ snippet: { resourceId: { channelId: "c1" }, title: "Channel 1" } }]
				}))
			}
			res.end(JSON.stringify({
				items: [{ snippet: { resourceId: { channelId: "c2" }, title: "Channel 2" } }]
			}))
		},
		async (url) => {
			const client = makeClient(url)
			const subs = await client.listSubscriptions()
			assert.deepEqual(subs, [
				{ channelId: "c1", title: "Channel 1" },
				{ channelId: "c2", title: "Channel 2" }
			])
		}
	)
})

test("a nextPageToken that never changes fails instead of hanging", async () => {
	let calls = 0

	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			if (url.pathname.endsWith("/token")) {
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }))
			}
			calls++
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({
				nextPageToken: "stuck",
				items: [{ snippet: { resourceId: { channelId: "c1" }, title: "Channel 1" } }]
			}))
		},
		async (url) => {
			const client = makeClient(url)
			await assert.rejects(() => client.listSubscriptions(), /repeated/i)
			assert.ok(calls <= 3, "a repeated token must be caught on the first repeat, not after many pages")
		}
	)
})

test("a revoked refresh token fails loudly", async () => {
	await withServer(
		(req, res) => {
			res.writeHead(400, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "invalid_grant" }))
		},
		async (url) => {
			const client = makeClient(url)
			await assert.rejects(() => client.getAccessToken(), /OAuth 400/)
		}
	)
})

test("a quota error mid-batch reports the videos already fetched", async () => {
	let batches = 0

	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			if (url.pathname.endsWith("/token")) {
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }))
			}
			batches++
			if (batches === 2) {
				res.writeHead(403, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }))
			}
			const ids = (url.searchParams.get("id") || "").split(",").filter(Boolean)
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({
				items: ids.map((id) => ({
					id,
					snippet: { title: "t", description: "d", publishedAt: "2026-08-29T10:00:00Z", channelTitle: "c" },
					statistics: { viewCount: "100" },
					contentDetails: { duration: "PT10M" }
				}))
			}))
		},
		async (url) => {
			const client = makeClient(url)
			const ids = Array.from({ length: 120 }, (_, i) => `video${i}`)
			let caught
			try {
				await client.listVideoDetails(ids)
			} catch (e) {
				caught = e
			}
			assert.match(caught.message, /quota/i)
			assert.equal(caught.partial.length, 50, "the first successful batch is preserved on the thrown error")
		}
	)
})
