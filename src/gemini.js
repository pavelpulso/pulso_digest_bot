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
 * Генерирует связный текстовый дайджест за день с темами и ссылками.
 * @param {Array<{ id: string, channel: string, post_id: number, text: string, link: string }>} posts
 * @param {string} dateLabel например "24 мая 2025"
 * @param {string} [userProfile]
 * @returns {Promise<string>}
 */
export async function generateSummary(posts, dateLabel, userProfile = "") {
  if (posts.length === 0) return `📋 Дайджест за ${dateLabel}\n\nНет постов за выбранный день.`;

  const list = posts.map((p) => ({
    id: p.id,
    channel: p.channel,
    post_id: p.post_id,
    text: (p.text || "").slice(0, 1500),
    link: p.link
  }));

  const prompt = `Сгенерируй связный дайджест за ${dateLabel} по следующим постам из Telegram-каналов.

Профиль читателя: ${userProfile || "не указан"}

Посты:
${JSON.stringify(list, null, 2)}

Формат ответа (строго на русском):
1. Заголовок: 📋 Дайджест за ${dateLabel}
2. Для каждой смысловой темы — блок:
   🔹 Тема: [название темы]
   [1–3 предложения обобщения]
   [Подробнее →](ссылка на пост)
   ✦ Почему выбрано: [краткое обоснование]

Используй только ссылки из полей link постов. Не добавляй markdown кроме заголовка и ссылок.`;

  return chat(prompt);
}

export default { rankPosts, generateSummary, chat };
