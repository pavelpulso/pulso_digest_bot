/**
 * Probes OpenRouter free models with the same shape rankPosts sends, so a dead route shows up
 * here instead of at 04:00 UTC. Run: node tools/probe-openrouter.mjs
 */
import "dotenv/config"

const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.error("OPENROUTER_API_KEY must be set")
  process.exit(1)
}

const candidates = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
    process.env.OPENROUTER_MODEL,
    "nvidia/nemotron-3-super-120b-a12b:free",
    "google/gemma-4-31b-it:free",
    "thinkingmachines/inkling:free",
    "z-ai/glm-5.2:free"
  ].filter(Boolean)

for (const model of candidates) {
  const startedAt = Date.now()
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: 'Верни только JSON: {"items":[{"id":1,"score":0.5,"reason":"короткая причина"}]}' }]
      })
    })
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content ?? JSON.stringify(data.error ?? data)
    console.log(`${res.status === 200 ? "OK  " : "FAIL"} ${model} | ${res.status} | ${Date.now() - startedAt}ms | ${String(text).replace(/\s+/g, " ").slice(0, 140)}`)
  } catch (e) {
    console.log(`FAIL ${model} | threw | ${e.message}`)
  }
}
