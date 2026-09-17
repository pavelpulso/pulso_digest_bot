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
				() => postJson(url, { body: {}, sleep: async () => {} }),
				(err) => {
					assert.match(err.message, /502/)
					assert.match(err.message, /proxy is down/)
					return true
				}
			)
		}
	)
})

test("a 503 spike is retried with backoff instead of failing the whole run", async () => {
	let hits = 0
	const waits = []

	await withServer(
		(req, res) => {
			hits++
			if (hits < 3) {
				res.writeHead(503, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: { code: 503, message: "high demand" } }))
				return
			}
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ ok: true }))
		},
		async (url) => {
			const data = await postJson(url, { body: {}, sleep: async (ms) => { waits.push(ms) } })
			assert.deepEqual(data, { ok: true })
			assert.equal(hits, 3)
			assert.deepEqual(waits, [1000, 2000], "backs off instead of hammering an overloaded model")
		}
	)
})

test("a 503 that never clears surfaces the provider body so the router can fall back", async () => {
	let hits = 0

	await withServer(
		(req, res) => {
			hits++
			res.writeHead(503)
			res.end("still overloaded")
		},
		async (url) => {
			await assert.rejects(
				() => postJson(url, { body: {}, sleep: async () => {} }),
				(err) => {
					assert.match(err.message, /503/)
					assert.match(err.message, /still overloaded/)
					return true
				}
			)
			assert.equal(hits, 3, "gives up after the retry budget, not endlessly")
		}
	)
})

test("a 400 is not retried — a bad request will not fix itself", async () => {
	let hits = 0

	await withServer(
		(req, res) => {
			hits++
			res.writeHead(400)
			res.end("bad model")
		},
		async (url) => {
			await assert.rejects(() => postJson(url, { body: {}, sleep: async () => {} }), /400/)
			assert.equal(hits, 1)
		}
	)
})

test("an error smuggled inside a 200 is treated as the failure it is", async () => {
	let hits = 0

	await withServer(
		(req, res) => {
			hits++
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: { code: 429, message: "rate-limited upstream" } }))
		},
		async (url) => {
			await assert.rejects(
				() => postJson(url, { body: {}, sleep: async () => {} }),
				(err) => {
					assert.match(err.message, /429/)
					assert.match(err.message, /rate-limited upstream/)
					return true
				}
			)
			assert.equal(hits, 1, "a non-5xx body error is not worth retrying")
		}
	)
})

test("a 200 carrying an upstream 503 is retried like a real 503", async () => {
	let hits = 0
	const waits = []

	await withServer(
		(req, res) => {
			hits++
			res.writeHead(200, { "Content-Type": "application/json" })
			if (hits < 3) {
				// OpenRouter's shape when the model behind a route is overloaded.
				res.end(JSON.stringify({ error: { code: 503, message: "Upstream error: Service temporarily overloaded" } }))
				return
			}
			res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }))
		},
		async (url) => {
			const data = await postJson(url, { body: {}, sleep: async (ms) => { waits.push(ms) } })
			assert.ok(data.choices, "recovers once the upstream clears")
			assert.equal(hits, 3)
			assert.deepEqual(waits, [1000, 2000])
		}
	)
})

test("a normal response carrying no error field is untouched", async () => {
	await withServer(
		(req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }))
		},
		async (url) => {
			const data = await postJson(url, { body: {}, sleep: async () => {} })
			assert.equal(data.choices[0].message.content, "hi")
		}
	)
})
