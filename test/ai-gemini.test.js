import { test } from "node:test"
import assert from "node:assert/strict"
import { GeminiAI } from "../src/ai/GeminiAI.js"
import { withServer } from "./helpers.js"

test("Gemini reports the proxy's failure instead of a JSON parse error", async () => {
	await withServer(
		(req, res) => {
			res.writeHead(502, { "Content-Type": "text/html" })
			res.end("<html>proxy is down</html>")
		},
		async (url) => {
			const ai = new GeminiAI({ proxyUrl: url.replace(/\/$/, ""), apiKey: "k", model: "m" })
			await assert.rejects(
				() => ai.rankPosts([{ id: "1", channel: "c", text: "hello" }], ""),
				(err) => {
					assert.match(err.message, /502/)
					assert.match(err.message, /proxy is down/)
					return true
				}
			)
		}
	)
})

test("an explicit endpoint is called verbatim, with no proxy path appended", async () => {
	let seenPath = null

	await withServer(
		(req, res) => {
			seenPath = req.url
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }))
		},
		async (url) => {
			const ai = new GeminiAI({
				baseUrl: `${url}v1beta/openai/chat/completions`,
				apiKey: "k",
				model: "gemini-2.5-flash"
			})
			await ai.rankPosts([{ id: "1", channel: "c", text: "hello" }], "")
			assert.equal(seenPath, "/v1beta/openai/chat/completions")
		}
	)
})
