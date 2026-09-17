/**
 * Runs rankPosts through the real router — batching, prompts, JSON parsing and fallback —
 * on synthetic posts, so a provider that only looks healthy to a raw HTTP probe still has to
 * survive the path the digest actually takes. Sends nothing to anyone.
 *
 *   node tools/probe-ranking.mjs              # whatever AI_PROVIDER selects
 *   node tools/probe-ranking.mjs openrouter   # force one provider
 */
import "dotenv/config"

const forced = process.argv[2]
if (forced) process.env.AI_PROVIDER = forced

const { AIRouter } = await import("../src/ai/index.js")

const posts = Array.from({ length: 40 }, (_, i) => ({
  id: `p${i + 1}`,
  channel: i % 2 ? "durov" : "seliger",
  text: `Заголовок ${i + 1}. Команда перестроила процесс разработки и рассказывает, что из этого вышло на дистанции в полгода.`
}))

const router = new AIRouter()
const startedAt = Date.now()
const ranked = await router.rankPosts(posts, "Интересуют технологии и продуктовая разработка.")

const scored = ranked.filter((r) => typeof r?.score === "number")
console.log(`ranked ${ranked.length}/${posts.length} in ${Date.now() - startedAt}ms, ${scored.length} with a numeric score`)
console.log(ranked.slice(0, 3))

if (scored.length < posts.length) {
  console.error(`INCOMPLETE: ${posts.length - scored.length} posts came back unscored`)
  process.exit(1)
}
