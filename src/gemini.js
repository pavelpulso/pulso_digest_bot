/**
 * Запросы к Gemini API через OpenAI-совместимый прокси.
 */

const GEMINI_PROXY_URL = (process.env.GEMINI_PROXY_URL || "").replace(/\/$/, "")
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash"

/**
 * Делает запрос к Gemini API с повторными попытками при 429.
 */
async function chat(prompt, options = {}) {
  if (!GEMINI_PROXY_URL || !GEMINI_API_KEY) {
    throw new Error("GEMINI_PROXY_URL and GEMINI_API_KEY must be set")
  }

  const url = `${GEMINI_PROXY_URL}/openai/v1/chat/completions`
  const body = {
    model: GEMINI_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: options.temperature ?? 0,
    stream: false
  }
  if (options.maxTokens) body.max_tokens = options.maxTokens
  if (options.responseFormat) {
    body.response_format = options.responseFormat
  }

  const maxRetries = 3
  let lastError = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GEMINI_API_KEY}`
        },
        body: JSON.stringify(body)
      })

      if (res.status === 429) {
        const waitMs = 1000 * attempt // 1s, 2s, 3s
        console.log(`[Gemini] 429 Too Many Requests. Retry ${attempt}/${maxRetries} after ${waitMs}ms`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`Gemini API ${res.status}: ${errText}`)
      }

      const data = await res.json()
      const text = data.choices?.[0]?.message?.content
      if (text == null) throw new Error("Gemini API: empty response")
      return text
    } catch (e) {
      if (e.message.includes("429") && attempt < maxRetries) {
        lastError = e
        continue
      }
      throw e
    }
  }

  throw lastError || new Error("Gemini API: max retries exceeded")
}

/**
 * Ранжирует посты для пользователя. Возвращает массив { post_id, score, reason }.
 * @param {Array<{ id: string, channel: string, text: string }>} posts
 * @param {string} [userProfile]
 * @param {{ channelPriorities?: Record<string, number>, feedback?: { liked: string[], disliked: string[] }, onProgress?: (percent: number) => void }} [options]
 * @returns {Promise<Array<{ post_id: string, score: number, reason: string }>>}
 */
export async function rankPosts(posts, userProfile = "", options = {}) {
  if (posts.length === 0) return []

  const { onProgress } = options
  if (typeof onProgress === "function") onProgress(10)

  const list = posts.map((p) => ({
    id: p.id,
    channel: p.channel,
    text: (p.text || "").slice(0, 2000)
  }))

  const channelPriorities = options.channelPriorities || {}
  const importantChannels =
    Object.keys(channelPriorities).filter((ch) => channelPriorities[ch] === 2).length > 0
      ? Object.entries(channelPriorities)
        .filter(([, p]) => p === 2)
        .map(([ch]) => ch)
        .join(", ")
      : ""

  const priorityHint =
    importantChannels === ""
      ? ""
      : `\nВажные каналы для читателя (давай им чуть больший вес при равной релевантности): ${importantChannels}.`

  const feedback = options.feedback || {}
  const liked = feedback.liked || []
  const disliked = feedback.disliked || []
  const feedbackHint =
    liked.length > 0 || disliked.length > 0
      ? `\nОбратная связь читателя: посты с id из списка [${liked.join(", ")}] он отметил как релевантные (ставь похожим по тематике/стилю выше). Посты с id [${disliked.join(", ")}] — как нерелевантные (понижай похожее).`
      : ""

  const prompt = `Ты — редактор дайджеста. Оцени каждый пост для читателя (0.0–1.0) и объясни выбор. Будь строг: в дайджест должно попадать только то, что реально может толкнуть этого человека вперёд.

Правила оценки:
- Ставь score >= 0.6 только постам с очевидной личной пользой для этого читателя: конкретное действие, решение, навык, возможность, привязка к его профилю и целям.
- Посты «просто интересные» или без явной привязки к профилю — score 0.3–0.5. Не раздувай высокие оценки.
- Цель: в дайджест попадало только то, что даёт явную пользу этому человеку, а не «на всякий случай».

Контекст читателя (интересы, профессия, цели): ${userProfile || "не указан"}
${priorityHint}
${feedbackHint}

Посты (id, channel, text):
${JSON.stringify(list, null, 2)}

В reason обязательно укажи: как именно этот пост может помочь этому читателю двигаться вперёд (карьера, жизнь, решения) — привязка к его профилю и целям, не общие слова. Верни JSON — массив объектов: post_id (строка), score (число 0–1), reason (строка, одно предложение).`

  if (typeof onProgress === "function") onProgress(50)
  const raw = await chat(prompt, { responseFormat: { type: "json_object" } })
  if (typeof onProgress === "function") onProgress(80)
  
  const cleaned = raw.replace(/```\w*\n?/g, "").trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error("Gemini: invalid JSON for rankPosts")
  }
  if (!Array.isArray(parsed)) {
    if (parsed && Array.isArray(parsed.ranking)) parsed = parsed.ranking
    else if (parsed && Array.isArray(parsed.posts)) parsed = parsed.posts
    else if (parsed && Array.isArray(parsed.items)) parsed = parsed.items
    else throw new Error("Gemini: expected array in JSON")
  }
  if (!Array.isArray(parsed)) throw new Error("Gemini: expected array")
  
  if (typeof onProgress === "function") onProgress(100)
  return parsed.map((item) => ({
    post_id: String(item.post_id),
    score: Number(item.score) || 0,
    reason: String(item.reason || "")
  }))
}

/**
 * Генерирует блоки дайджеста и главный тизер.
 * @param {Array<{ id: string, channel: string, post_id: number, text: string, link: string }>} posts
 * @param {string} dateLabel например "24 Feb 2026"
 * @param {string} [userProfile]
 * @param {number} [maxItems=10] максимум блоков в дайджесте
 * @param {{ onProgress?: (percent: number) => void }} [options]
 * @returns {Promise<{ teaser: string|null, blocks: Array<{ ids: string[], essence: string, potential: string, emoji: string }> }>}
 */
export async function generateSummaryBlocks(posts, dateLabel, userProfile = "", maxItems = 10, options = {}) {
  if (posts.length === 0) return { teaser: null, blocks: [] }

  const { onProgress } = options
  if (typeof onProgress === "function") onProgress(10)

  const list = posts.map((p) => ({
    id: p.id,
    channel: p.channel,
    post_id: p.post_id,
    text: (p.text || "").slice(0, 1500),
    link: p.link
  }))

  const maxBlocks = Math.min(20, Math.max(3, maxItems))

  const prompt = `Ты — редактор дайджеста. По списку постов сформируй дайджест за ${dateLabel}. Включай в blocks только посты с явной пользой для этого читателя; не добавляй блоки «для заполнения». Лучше вернуть меньше блоков (5–7), если остальное не дотягивает по пользе.

Контекст читателя (интересы, профессия, цели): ${userProfile || "не указан"}

Посты:
${JSON.stringify(list, null, 2)}

Правила:
- Верни JSON-объект с полями: teaser (строка) и blocks (массив).
- teaser: одна короткая фраза (главное за день), цепляющая этого читателя. Не более 10–12 слов.
- В blocks не более ${maxBlocks} блоков. Только посты с явной личной пользой для этого читателя (действие, решение, навык, возможность). Порядок: сначала то, что сильнее всего может улучшить жизнь/карьеру/счастье и толкнуть вперёд; затем остальное по релевантности. Если мало по-настоящему полезного — верни меньше блоков.
- НЕ включай: опросы; анонсы встреч; рекламу и коммерческие посты (Реклама, ИНН, erid). Только информативные материалы.
- Если 2+ постов про одну новость — объедини в один блок (ids = массив id). Остальные — по одному блоку.
- Каждый блок: ids, essence (суть — одно предложение, строго до 15–20 слов), potential (зачем смотреть — как это помогает этому читателю двигаться вперёд, до 10–12 слов), emoji (один эмодзи), action (quick win — одно конкретное действие на 5–15 минут, повелительное наклонение; то, что реально продвинет читателя; до 8–12 слов; обязательно заполняй, кроме постов без прикладного вывода).
- В essence, potential и action не используй символы * _ \` [ ] — только обычный текст.

Верни JSON-объект с полями teaser и blocks.`

  if (typeof onProgress === "function") onProgress(50)
  const raw = await chat(prompt, { responseFormat: { type: "json_object" } })
  if (typeof onProgress === "function") onProgress(75)
  
  const cleaned = raw.replace(/```\w*\n?/g, "").trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error("Gemini: invalid JSON for summary blocks")
  }

  let teaser = null
  let rawBlocks = []
  if (Array.isArray(parsed)) {
    rawBlocks = parsed
  } else if (parsed && Array.isArray(parsed.blocks)) {
    teaser = typeof parsed.teaser === "string" ? parsed.teaser.trim().slice(0, 200) : null
    rawBlocks = parsed.blocks
  } else {
    throw new Error("Gemini: expected object with blocks array or array")
  }

  const idSet = new Set(list.map((p) => p.id))
  const seenIds = new Set()

  const blocks = rawBlocks
    .map((item) => {
      const ids = Array.isArray(item.ids) ? item.ids : item.id != null ? [String(item.id)] : []
      const validIds = ids.filter((id) => idSet.has(String(id)) && !seenIds.has(String(id)))
      validIds.forEach((id) => seenIds.add(String(id)))
      if (validIds.length === 0) return null
      return {
        ids: validIds,
        essence: String(item.essence || "").trim(),
        potential: String(item.potential || "").trim(),
        emoji: String(item.emoji || "📌").trim().slice(0, 2),
        action: String(item.action || "").trim()
      }
    })
    .filter(Boolean)

  if (typeof onProgress === "function") onProgress(100)
  return { teaser, blocks: blocks.slice(0, maxBlocks) }
}

/**
 * Рекомендует каналы пользователю по профилю (интересы, профессия).
 * @param {string} userProfile
 * @param {string[]} channelUsernames список @username без @
 * @returns {Promise<Array<{ username: string, reason: string }>>}
 */
export async function recommendChannels(userProfile, channelUsernames) {
  if (!channelUsernames || channelUsernames.length === 0) return []

  const list = channelUsernames.slice(0, 100)
  const prompt = `Дан профиль читателя и список каналов Telegram (username без @).

Профиль читателя (интересы, профессия, цели): ${userProfile || "не указан"}

Список каналов: ${list.join(", ")}

Выбери до 5 каналов, которые наиболее релевантны этому читателю. Учитывай типичную тематику канала по названию (username часто отражает тематику). Верни JSON-объект с полем channels — массив объектов: username (строка, из списка), reason (до 10 слов, почему канал подходит).`

  const raw = await chat(prompt, { responseFormat: { type: "json_object" }, maxTokens: 1024 })
  const cleaned = raw.replace(/```\w*\n?/g, "").trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    console.error("[recommendChannels] invalid JSON:", cleaned.slice(0, 300))
    throw new Error("Gemini: invalid JSON for recommendChannels")
  }
  let arr = []
  if (Array.isArray(parsed)) arr = parsed
  else if (parsed && Array.isArray(parsed.channels)) arr = parsed.channels
  else if (parsed && Array.isArray(parsed.recommendations)) arr = parsed.recommendations
  else if (parsed && Array.isArray(parsed.result)) arr = parsed.result
  else if (parsed && Array.isArray(parsed.items)) arr = parsed.items
  else {
    // попытка найти первый массив в объекте
    const firstArr = Object.values(parsed || {}).find(Array.isArray)
    if (firstArr) arr = firstArr
  }
  const set = new Set(list.map((u) => u.toLowerCase()))
  return arr
    .filter((item) => set.has(String(item.username || item.channel || "").toLowerCase()))
    .slice(0, 5)
    .map((item) => ({
      username: String(item.username || item.channel || "").toLowerCase(),
      reason: String(item.reason || "").trim().slice(0, 200)
    }))
}

/**
 * Анализирует канал по последним постам и возвращает персонализированный скоринг.
 * @param {Array<{ id: string, channel: string, text: string, link: string }>} posts
 * @param {string} channel имя канала (без @)
 * @param {string} [userProfile]
 * @returns {Promise<{ score: number, signal_noise: number, verdict: 'keep'|'mute'|'unsubscribe', summary: string, arguments: string[] }>}
 */
export async function analyzeChannel(posts, channel, userProfile = "") {
  const list = posts.map((p) => ({
    text: (p.text || "").slice(0, 1000),
    link: p.link
  }))

  const prompt = `Ты — персональный редактор. Проанализируй канал @${channel} для этого читателя по его последним постам.

Профиль читателя (интересы, профессия, цели): ${userProfile || "не указан"}

Последние посты канала (${list.length} шт.):
${JSON.stringify(list, null, 2)}

Верни JSON-объект с полями:
- score: число от 0 до 10 (насколько канал полезен именно этому читателю; учитывай релевантность тематики, соотношение полезного контента к рекламе/шуму)
- signal_noise: число от 0.0 до 1.0 (доля постов с реальной пользой vs шум/реклама/репосты)
- verdict: строка — одно из: "keep" (держать, канал реально полезен), "mute" (снизить приоритет, посмотрим), "unsubscribe" (мало пользы, стоит отписаться)
- summary: строка до 20 слов — суть канала и почему такой вердикт
- arguments: массив из 3 строк — конкретные аргументы вердикта (каждый до 15 слов), с привязкой к профилю читателя`

  const raw = await chat(prompt, { responseFormat: { type: "json_object" } })
  const cleaned = raw.replace(/```\w*\n?/g, "").trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error("Gemini: invalid JSON for analyzeChannel")
  }
  return {
    score: Number(parsed.score) || 0,
    signal_noise: Number(parsed.signal_noise) || 0,
    verdict: ["keep", "mute", "unsubscribe"].includes(parsed.verdict) ? parsed.verdict : "mute",
    summary: String(parsed.summary || "").trim().slice(0, 300),
    arguments: Array.isArray(parsed.arguments)
      ? parsed.arguments.slice(0, 3).map((a) => String(a).trim())
      : []
  }
}

/**
 * Батч-анализ всех каналов пользователя.
 * @param {Array<{ channel: string, posts: Array<{ text: string }> }>} channelsData
 * @param {string} [userProfile]
 * @returns {Promise<Array<{ channel: string, score: number, verdict: string, summary: string }>>}
 */
export async function auditAllChannels(channelsData, userProfile = "") {
  if (channelsData.length === 0) return []

  const list = channelsData.map((cd) => ({
    channel: cd.channel,
    posts: cd.posts.slice(0, 20).map((p) => (p.text || "").slice(0, 500))
  }))

  const prompt = `Ты — персональный редактор. Оцени каждый канал для этого читателя по его последним постам.

Профиль читателя (интересы, профессия, цели): ${userProfile || "не указан"}

Каналы и их последние посты:
${JSON.stringify(list, null, 2)}

Верни JSON-объект с полем channels — массив объектов, для каждого канала:
- channel: имя канала (из входного списка)
- score: число от 0 до 10 (польза для ЭТОГО читателя)
- verdict: "keep", "mute" или "unsubscribe"
- summary: до 12 слов — суть вердикта

Отсортируй по score убыванию. Будь строг: ставь низкий score каналам без явной пользы для профиля читателя.`

  const raw = await chat(prompt, { responseFormat: { type: "json_object" }, maxTokens: 2048 })
  const cleaned = raw.replace(/```\w*\n?/g, "").trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error("Gemini: invalid JSON for auditAllChannels")
  }
  let arr = []
  if (Array.isArray(parsed)) arr = parsed
  else if (parsed && Array.isArray(parsed.channels)) arr = parsed.channels

  const known = new Set(channelsData.map((cd) => cd.channel.toLowerCase()))
  return arr
    .filter((item) => known.has(String(item.channel || "").toLowerCase()))
    .map((item) => ({
      channel: String(item.channel).toLowerCase(),
      score: Number(item.score) || 0,
      verdict: ["keep", "mute", "unsubscribe"].includes(item.verdict) ? item.verdict : "mute",
      summary: String(item.summary || "").trim().slice(0, 200)
    }))
    .sort((a, b) => b.score - a.score)
}

export default { rankPosts, generateSummaryBlocks, recommendChannels, analyzeChannel, auditAllChannels, chat }
