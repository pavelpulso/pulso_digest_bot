/**
 * Промпты для AI-провайдеров.
 * Вынесены в отдельный файл для соблюдения DRY и упрощения тестирования.
 */

/**
 * Промпт для ранжирования постов.
 */
export function buildRankPrompt(list, userProfile, importantChannels, liked, disliked) {
  const priorityHint = importantChannels ? `\nВажные каналы: ${importantChannels}.` : ""
  const feedbackHint = (liked.length || disliked.length)
    ? `\nОбратная связь: релевантные [${liked.join(", ")}], нерелевантные [${disliked.join(", ")}].`
    : ""

  return `Ты — редактор дайджеста. Оцени каждый пост для читателя (0.0–1.0). Будь строг: только посты с явной личной пользой.

Правила:
- Score >= 0.6 только для постов с очевидной пользой: действие, решение, навык, возможность.
- «Просто интересные» — score 0.3–0.5.

Контекст читателя: ${userProfile || "не указан"}${priorityHint}${feedbackHint}

Посты:
${JSON.stringify(list, null, 2)}

Верни JSON-массив: post_id (строка), score (число 0–1), reason (строка).`
}

/**
 * Промпт для генерации блоков дайджеста.
 */
export function buildSummaryPrompt(list, dateLabel, userProfile, maxBlocks) {
  return `Ты — редактор дайджеста. Дайджест за ${dateLabel}. Включай только посты с явной пользой.

Контекст читателя: ${userProfile || "не указан"}
Посты: ${JSON.stringify(list, null, 2)}

Правила:
- JSON с teaser и blocks (макс ${maxBlocks}).
- teaser: до 12 слов.
- blocks: только полезное, без рекламы/опросов/анонсов.
- Объединяй посты об одном в один блок.
- Каждый блок: ids, essence (15-20 слов), potential (10-12 слов), emoji, action (5-15 мин).
- Без спецсимволов * _ \` [ ].

Верни JSON.`
}

/**
 * Промпт для анализа канала.
 */
export function buildAnalyzeChannelPrompt(channel, userProfile, list) {
  return `Анализируй канал @${channel} для читателя.

Профиль: ${userProfile || "не указан"}
Посты (${list.length}): ${JSON.stringify(list, null, 2)}

Верни JSON: score (0-10), signal_noise (0-1), verdict (keep/mute/unsubscribe), summary (20 слов), arguments (3 строки).`
}

/**
 * Промпт для аудита всех каналов.
 */
export function buildAuditAllChannelsPrompt(userProfile, list) {
  // Упрощаем данные для каждого канала — только текст постов и views
  const simplified = list.map(ch => ({
    channel: ch.channel,
    postCount: ch.postCount,
    posts: ch.posts.map(p => ({ text: p.text.slice(0, 300), views: p.views }))
  }))

  return `Оцени каналы для читателя. Профиль: ${userProfile || "не указан"}

Каналы: ${JSON.stringify(simplified)}

Для каждого: score (0-10), signal_noise (0-1), avg_views, value_per_post (score/postCount), verdict (keep/mute/unsubscribe), summary (10 слов).

Верни JSON: {"channels":[{"channel":"name","score":8,"signal_noise":0.7,"avg_views":1000,"value_per_post":0.8,"verdict":"keep","summary":"текст"}]}`
}

/**
 * Промпт для рекомендации каналов.
 */
export function buildRecommendChannelsPrompt(userProfile, list) {
  return `Подбери до 5 каналов для читателя.

Профиль: ${userProfile || "не указан"}
Каналы: ${list.join(", ")}

Верни ТОЛЬКО JSON без пояснений. Формат:
{
  "channels": [
    {"username": "channel", "reason": "краткое описание (10 слов)"}
  ]
}`
}
