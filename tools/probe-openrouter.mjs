/**
 * Probes OpenRouter free models with the prompt rankPosts actually sends, at the batch size it
 * actually sends it at, so a dead or drifting route shows up here instead of at 04:00 UTC.
 * A model that answers a toy request can still return a single object instead of an array once
 * the prompt is long — which is exactly how the first pick failed.
 *
 *   node tools/probe-openrouter.mjs                  # candidate list, 40-post real prompt
 *   node tools/probe-openrouter.mjs --posts=20       # at a smaller batch size
 *   node tools/probe-openrouter.mjs --runs=3         # repeat, to catch flaky routes
 *   node tools/probe-openrouter.mjs --list           # every :free model the account can see
 *   node tools/probe-openrouter.mjs <model>...       # probe exactly these
 */
import "dotenv/config"
import { JSON_ARRAY_KEYS } from "../src/ai/constants.js"
import { buildRankPrompt } from "../src/ai/prompts.js"

const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.error("OPENROUTER_API_KEY must be set")
  process.exit(1)
}

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? parseInt(hit.split("=")[1], 10) : fallback
}
const postCount = flag("posts", 40)
const runs = flag("runs", 1)
const named = args.filter((a) => !a.startsWith("--"))

if (args.includes("--list")) {
  const res = await fetch("https://openrouter.ai/api/v1/models")
  const data = await res.json()
  data.data
    .filter((m) => m.id.endsWith(":free"))
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
    .forEach((m) => console.log(m.id, m.context_length))
  process.exit(0)
}

const posts = Array.from({ length: postCount }, (_, i) => ({
  id: `p${i + 1}`,
  channel: i % 2 ? "durov" : "seliger",
  text: `Заголовок ${i + 1}. Команда перестроила процесс разработки и рассказывает, что из этого вышло за полгода.`
}))
const prompt = buildRankPrompt(posts, "Интересуют технологии и продуктовая разработка.", "", {}, null)

/** The same shapes BaseAI accepts — a bare array, or an array under one of the known keys. */
function extractItems(raw) {
  const cleaned = raw.replace(/```\w*\n?/g, "").trim()
  const start = cleaned.indexOf("[")
  if (start !== -1) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, cleaned.lastIndexOf("]") + 1))
      if (Array.isArray(parsed)) return parsed
    } catch { /* fall through to the object form */ }
  }
  try {
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) return parsed
    for (const k of JSON_ARRAY_KEYS) if (Array.isArray(parsed?.[k])) return parsed[k]
    const firstArr = Object.values(parsed || {}).find(Array.isArray)
    if (firstArr) return firstArr
  } catch { /* unparseable */ }
  return null
}

const candidates = named.length
  ? named
  : [
    process.env.OPENROUTER_MODEL,
    "nex-agi/nex-n2.5-pro:free",
    "nex-agi/nex-n2.5-mini:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "dots-studio/dots-3-note-preview:free",
    "inclusionai/ling-3.0-flash-sante:free",
    "poolside/laguna-s-2.1:free",
    "cohere/north-mini-code:free",
    "google/gemma-4-26b-a4b-it:free",
    "google/gemma-4-31b-it:free",
    "z-ai/glm-5.2:free"
  ].filter((m, i, all) => m && all.indexOf(m) === i)

for (const model of candidates) {
  for (let run = 1; run <= runs; run++) {
    const startedAt = Date.now()
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        // The providers time out at 60s, so a model that needs longer is unusable regardless
        // of what it would eventually answer.
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: postCount * 280 + 200,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }]
        })
      })
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content

      // OpenRouter answers an upstream failure with HTTP 200 and an error payload, so status
      // alone says nothing: a 200 is only a pass if it carries usable content.
      if (text == null) {
        const err = JSON.stringify(data.error ?? data).replace(/\s+/g, " ")
        console.log(`FAIL ${model} | run ${run} | ${res.status} no content | ${err.slice(0, 130)}`)
        continue
      }

      const items = extractItems(text)
      const scored = (items || []).filter((it) => (it?.post_id || it?.id) && typeof it?.score === "number")
      const verdict = items == null
        ? "NO ARRAY"
        : scored.length < postCount
          ? `SHORT ${scored.length}/${postCount}`
          : `OK ${scored.length}/${postCount}`
      console.log(`${verdict.startsWith("OK") ? "OK  " : "FAIL"} ${model} | run ${run} | ${Date.now() - startedAt}ms | ${verdict} | ${text.replace(/\s+/g, " ").slice(0, 90)}`)
    } catch (e) {
      console.log(`FAIL ${model} | run ${run} | threw | ${e.message}`)
    }
  }
}
