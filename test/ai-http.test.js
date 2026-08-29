import { test } from "node:test"
import assert from "node:assert/strict"
import { postJson } from "../src/ai/http.js"
import { withServer } from "./helpers.js"

test("a hanging endpoint aborts once the timeout elapses", async () => {
	await withServer(
		() => {},
		async (url) => {
			const started = Date.now()
			await assert.rejects(
				() => postJson(url, { apiKey: "k", body: {}, timeoutMs: 150 }),
				(err) => {
					assert.match(err.message, /timed out after 150ms/)
					return true
				}
			)
			assert.ok(Date.now() - started < 1000, "should abort quickly, not hang")
		}
	)
})

test("a 429 with Retry-After waits exactly that long, then succeeds", async () => {
	let hits = 0
	const waits = []

	await withServer(
		(req, res) => {
			hits++
			if (hits === 1) {
				res.writeHead(429, { "Retry-After": "2" })
				res.end("slow down")
				return
			}
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ ok: true }))
		},
		async (url) => {
			const data = await postJson(url, { body: {}, sleep: async (ms) => { waits.push(ms) } })
			assert.deepEqual(data, { ok: true })
			assert.deepEqual(waits, [2000], "waits the header value, not a hardcoded delay")
			assert.equal(hits, 2)
		}
	)
})

test("a 429 without Retry-After falls back to a full quota minute", async () => {
	let hits = 0
	const waits = []

	await withServer(
		(req, res) => {
			hits++
			if (hits === 1) {
				res.writeHead(429)
				res.end("rate limited")
				return
			}
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ ok: true }))
		},
		async (url) => {
			await postJson(url, { body: {}, sleep: async (ms) => { waits.push(ms) } })
			assert.deepEqual(waits, [60000])
		}
	)
})

test("a non-JSON error response surfaces its status and body", async () => {
	await withServer(
		(req, res) => {
			res.writeHead(502, { "Content-Type": "text/html" })
			res.end("<html>proxy is down</html>")
		},
		async (url) => {
			await assert.rejects(
				() => postJson(url, { body: {} }),
				(err) => {
					assert.match(err.message, /502/)
					assert.match(err.message, /proxy is down/)
					return true
				}
			)
		}
	)
})
