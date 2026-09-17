/**
 * Probes OpenRouter free models with the same shape rankPosts sends, so a dead route shows up
 * here instead of at 04:00 UTC.
 *
 *   node tools/probe-openrouter.mjs            # probe the default candidate list
 *   node tools/probe-openrouter.mjs --list     # every :free model the account can see
 *   node tools/probe-openrouter.mjs --heavy    # a full ranking batch, not a toy request
 *   node tools/probe-openrouter.mjs <model>... # probe exactly these
 */
import "dotenv/config"

const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.error("OPENROUTER_API_KEY must be set")
  process.exit(1)
}

const args = process.argv.slice(2)
const heavy = args.includes("--heavy")
const list = args.includes("--list")
const named = args.filter((a) => !a.startsWith("--"))

async function listFreeModels() {
  const res = await fetch("https://openrouter.ai/api/v1/models")
  const data = await res.json()
  return data.data
    .filter((m) => m.id.endsWith(":free"))
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
    .map((m) => m.id)
}

if (list) {
  for (const id of await listFreeModels()) console.log(id)
  process.exit(0)
}

/** Mirrors a real ranking batch: 20 posts, Cyrillic titles, an 8-word Cyrillic reason each.
 * A model that answers the toy request can still truncate or drift on this one. */
function heavyPrompt() {
  const posts = Array.from({ length: 20 }, (_, i) => ({
    id: `p${i + 1}`,
    text: `Заголовок ${i + 1}: разбор того, как команда перестроила процесс и что из этого вышло на дистанции`
  }))
  return `Оцени релевантность каждого поста для читателя, которого интересуют технологии и продуктовая разработка.
Верни ТОЛЬКО JSON-объект вида {"items":[{"id":"p1","score":0.0,"reason":"причина до восьми слов","topic":"тема"}]}.
Посты:
${posts.map((p) => `${p.id}: ${p.text}`).join("\n")}`
}

const candidates = named.length
  ? named
  : [
    process.env.OPENROUTER_MODEL,
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "google/gemma-4-26b-a4b-it:free",
    "google/gemma-4-31b-it:free",
    "inclusionai/ling-3.0-flash-vl:free",
    "nex-agi/nex-n2.5-pro:free",
    "nex-agi/nex-n2.5-mini:free",
    "dots-studio/dots-3-note-preview:free",
    "z-ai/glm-5.2:free"
  ].filter(Boolean)

for (const model of candidates) {
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
        max_tokens: heavy ? 5600 : 300,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: heavy ? heavyPrompt() : 'Верни только JSON: {"items":[{"id":1,"score":0.5,"reason":"короткая причина"}]}'
        }]
      })
    })
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content

    // OpenRouter answers an upstream failure with HTTP 200 and an error payload, so status
    // alone says nothing: a 200 here is only a pass if it actually carries usable content.
    if (text == null) {
      const err = JSON.stringify(data.error ?? data)
      console.log(`FAIL ${model} | ${res.status} no content | ${err.replace(/\s+/g, " ").slice(0, 150)}`)
      continue
    }

    let items = null
    try {
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""))
      items = Array.isArray(parsed) ? parsed : parsed.items
    } catch {
      items = null
    }

    const verdict = items == null
      ? "UNPARSEABLE"
      : heavy && items.length < 20
        ? `SHORT(${items.length}/20)`
        : `OK(${items.length})`
    console.log(`${verdict.startsWith("OK") ? "OK  " : "FAIL"} ${model} | ${Date.now() - startedAt}ms | ${verdict} | ${String(text).replace(/\s+/g, " ").slice(0, 110)}`)
  } catch (e) {
    console.log(`FAIL ${model} | threw | ${e.message}`)
  }
}
