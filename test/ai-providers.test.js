import { test } from "node:test"
import assert from "node:assert/strict"
import { CliProxyAI } from "../src/ai/CliProxyAI.js"
import { GroqAI } from "../src/ai/GroqAI.js"
import { OpenRouterAI } from "../src/ai/OpenRouterAI.js"
import { withServer } from "./helpers.js"

const providers = [
	["Groq", (url) => new GroqAI({ apiKey: "k", baseUrl: url, timeoutMs: 150 })],
	["CliProxy", (url) => new CliProxyAI({ apiKey: "k", model: "m", baseUrl: url, timeoutMs: 150 })],
	["OpenRouter", (url) => new OpenRouterAI({ apiKey: "k", baseUrl: url, timeoutMs: 150 })]
]

for (const [name, build] of providers) {
	test(`${name} aborts a hanging endpoint instead of waiting forever`, async () => {
		await withServer(
			() => {},
			async (url) => {
				const ai = build(url)
				await assert.rejects(
					() => ai.rankPosts([{ id: "1", channel: "c", text: "hello" }], ""),
					(err) => {
						assert.match(err.message, /timed out after 150ms/)
						return true
					}
				)
			}
		)
	})
}

test("CliProxy stays out of the chain until the proxy is configured", async () => {
	assert.equal(await new CliProxyAI({ baseUrl: "", model: "" }).isReady(), false)
	assert.equal(await new CliProxyAI({ baseUrl: "http://127.0.0.1:8317", model: "gemini-2.5-pro" }).isReady(), true)
})

test("CliProxy appends the OpenAI path to a bare base URL, and leaves a full one alone", async () => {
	const paths = []

	await withServer(
		(req, res) => {
			paths.push(req.url)
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }))
		},
		async (url) => {
			const base = url.replace(/\/$/, "")
			for (const baseUrl of [base, `${base}/v1/chat/completions`]) {
				await new CliProxyAI({ apiKey: "k", model: "m", baseUrl }).rankPosts(
					[{ id: "1", channel: "c", text: "hello" }],
					""
				)
			}
			assert.deepEqual(paths, ["/v1/chat/completions", "/v1/chat/completions"])
		}
	)
})
