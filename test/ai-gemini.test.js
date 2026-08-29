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
