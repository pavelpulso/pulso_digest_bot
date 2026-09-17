/**
 * Prints what a provider actually answers to the real ranking prompt, so a parser failure can
 * be read rather than guessed at. Sends nothing to anyone.
 *
 *   node tools/probe-rank-raw.mjs openrouter
 */
import "dotenv/config"

const which = (process.argv[2] || "openrouter").toLowerCase()
const count = parseInt(process.argv[3], 10) || 20
const { GeminiAI } = await import("../src/ai/GeminiAI.js")
const { GroqAI } = await import("../src/ai/GroqAI.js")
const { OpenRouterAI } = await import("../src/ai/OpenRouterAI.js")
const { buildRankPrompt } = await import("../src/ai/prompts.js")

const provider = which === "gemini" ? new GeminiAI() : which === "groq" ? new GroqAI() : new OpenRouterAI()

const items = Array.from({ length: count }, (_, i) => ({
  id: `p${i + 1}`,
  channel: i % 2 ? "durov" : "seliger",
  text: `Заголовок ${i + 1}. Команда перестроила процесс разработки и рассказывает, что из этого вышло за полгода.`
}))

const prompt = buildRankPrompt(items, "Интересуют технологии и продуктовая разработка.", "", {}, null)
console.log(`--- provider: ${provider.toString()} model: ${provider.model}`)
console.log(`--- prompt length: ${prompt.length}`)

const raw = await provider._callAPI(prompt, { responseFormat: { type: "json_object" }, maxTokens: items.length * 280 + 200 })
console.log(`--- raw length: ${raw.length}, has "[": ${raw.includes("[")}`)
console.log("--- raw response (first 600 + last 300):")
console.log(raw.slice(0, 600))
if (raw.length > 900) console.log("...", raw.slice(-300))
