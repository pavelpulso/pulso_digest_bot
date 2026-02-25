/**
 * Запросы к Gemini API через OpenAI-совместимый прокси.
 */

const GEMINI_PROXY_URL = (process.env.GEMINI_PROXY_URL || "").replace(/\/$/, "");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash";

async function chat(prompt, options = {}) {
  if (!GEMINI_PROXY_URL || !GEMINI_API_KEY) {
    throw new Error("GEMINI_PROXY_URL and GEMINI_API_KEY must be set");
  }

  const url = `${GEMINI_PROXY_URL}/openai/v1/chat/completions`;
  const body = {
    model: GEMINI_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: options.temperature ?? 0,
    stream: false
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GEMINI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (text == null) throw new Error("Gemini API: empty response");
  return text;
}

/**
 * Ранжирует посты для пользователя. Возвращает массив { post_id, score, reason }.
 * @param {Array<{ id: string, channel: string, text: string }>} posts
 * @param {string} [userProfile]
 * @returns {Promise<Array<{ post_id: string, score: number, reason: string }>>}
 */
export async function rankPosts(posts, userProfile = "") {
  if (posts.length === 0) return [];

  const list = posts.map((p) => ({
    id: p.id,
    channel: p.channel,
    text: (p.text || "").slice(0, 2000)
  }));

  const prompt = `Ты — редактор дайджеста. Оцени релевантность каждого поста для читателя (0.0–1.0) и кратко объясни выбор.

Профиль читателя (интересы, профессия): ${userProfile || "не указан"}

Посты (id, channel, text):
${JSON.stringify(list, null, 2)}

Верни ТОЛЬКО валидный JSON — массив объектов с полями: post_id (строка), score (число 0–1), reason (строка, одно предложение). Без markdown и комментариев.
Пример: [{"post_id":"uuid1","score":0.9,"reason":"..."}, ...]`;

  const raw = await chat(prompt);
  const cleaned = raw.replace(/```\w*\n?/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Gemini: expected array");
  return parsed.map((item) => ({
    post_id: String(item.post_id),
    score: Number(item.score) || 0,
    reason: String(item.reason || "")
  }));
}

/**
 * Генерирует блоки дайджеста и главный тизер.
 * @param {Array<{ id: string, channel: string, post_id: number, text: string, link: string }>} posts
 * @param {string} dateLabel например "24 Feb 2026"
 * @param {string} [userProfile]
 * @param {number} [maxItems=10] максимум блоков в дайджесте
 * @returns {Promise<{ teaser: string|null, blocks: Array<{ ids: string[], essence: string, potential: string, emoji: string }> }>}
 */
export async function generateSummaryBlocks(posts, dateLabel, userProfile = "", maxItems = 10) {
  if (posts.length === 0) return { teaser: null, blocks: [] };

  const list = posts.map((p) => ({
    id: p.id,
    channel: p.channel,
    post_id: p.post_id,
    text: (p.text || "").slice(0, 1500),
    link: p.link
  }));

  const maxBlocks = Math.min(20, Math.max(3, maxItems));

  const prompt = `Ты — редактор дайджеста. По списку постов сформируй дайджест за ${dateLabel}.

Профиль читателя: ${userProfile || "не указан"}

Посты:
${JSON.stringify(list, null, 2)}

Правила:
- Верни JSON-объект с двумя полями: teaser (строка) и blocks (массив).
- teaser: одна короткая фраза (главное/самое важное за день) — что сразу цепляет. Не более 10–12 слов.
- Включи в blocks не более ${maxBlocks} блоков — только самые важные и релевантные. Остальные посты не включай.
- НЕ включай: опросы, анонсы встреч/мероприятий, приглашения на события, чисто рекламные посты. Только информативные материалы.
- Если 2+ постов про одну новость — объедини в один блок (ids = массив id). Остальные — по одному блоку.
- Расположи блоки по убыванию важности — самое важное первым.
- Каждый блок: ids (массив id из постов), essence (1–2 предложения), potential (одно предложение), emoji (один эмодзи по типу контента).

Верни ТОЛЬКО валидный JSON. Без markdown и комментариев.
Пример: {"teaser":"Релиз Qwen 3.5 и апскейлер от Magnific — прорывы в ИИ и медиа.","blocks":[{"ids":["uuid1"],"essence":"...","potential":"...","emoji":"🤖"},...]}`;

  const raw = await chat(prompt);
  const cleaned = raw.replace(/```\w*\n?/g, "").trim();
  const parsed = JSON.parse(cleaned);

  let teaser = null;
  let rawBlocks = [];
  if (Array.isArray(parsed)) {
    rawBlocks = parsed;
  } else if (parsed && Array.isArray(parsed.blocks)) {
    teaser = typeof parsed.teaser === "string" ? parsed.teaser.trim().slice(0, 200) : null;
    rawBlocks = parsed.blocks;
  } else {
    throw new Error("Gemini: expected object with blocks array or array");
  }

  const idSet = new Set(list.map((p) => p.id));
  const seenIds = new Set();

  const blocks = rawBlocks
    .map((item) => {
      const ids = Array.isArray(item.ids) ? item.ids : item.id != null ? [String(item.id)] : [];
      const validIds = ids.filter((id) => idSet.has(String(id)) && !seenIds.has(String(id)));
      validIds.forEach((id) => seenIds.add(String(id)));
      if (validIds.length === 0) return null;
      return {
        ids: validIds,
        essence: String(item.essence || "").trim(),
        potential: String(item.potential || "").trim(),
        emoji: String(item.emoji || "📌").trim().slice(0, 2)
      };
    })
    .filter(Boolean);

  return { teaser, blocks: blocks.slice(0, maxBlocks) };
}

export default { rankPosts, generateSummaryBlocks, chat };
