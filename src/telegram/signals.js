/**
 * Сигналы вовлечения из телеграм-поста: доля репостов и полярность реакций.
 *
 * Обе метрики — доли, а не абсолютные числа, и это не стилистика. Дайджест ранжирует
 * посты, которым несколько часов: абсолютные просмотры у поста в 9 утра и в 9 вечера
 * различаются на порядок просто из-за возраста. Доля же растёт вместе со знаменателем
 * и от возраста почти не зависит, поэтому здесь не нужна «зрелость», как для видео.
 */

/** Реакции, означающие «ценно». */
const POSITIVE = ["🔥", "👍", "❤", "❤‍🔥", "🤯", "💯", "🏆", "⚡", "👏", "🙏", "✍", "🤝", "🆒", "🎉"]

/** Реакции, означающие «плохо» — единственный сигнал, которого нет ни у просмотров, ни у репостов. */
const NEGATIVE = ["👎", "💩", "🤡", "🥱", "🤬", "🤨"]

/**
 * 😁 и 🤣 сознательно не в плюсе: по данным каналов они доминируют на шуточных постах
 * (😁978 у addmeto, 😁870 у duditagain) и означают «смешно», а не «важно». 😢 — реакция
 * на плохую новость, а не на плохой пост. Всё это и любые кастомные эмодзи — нейтральны.
 */
const POLARITY = new Map([
  ...POSITIVE.map((e) => [e, 1]),
  ...NEGATIVE.map((e) => [e, -1])
])

/** Ниже этого числа классифицированных реакций полярность — мнение двух человек. */
export const MIN_POLARITY_REACTIONS = 20

/** Насколько полярность поднимает и опускает скор. Опускает сильнее: пост, набравший
 * охват через 🤡, — именно тот случай, ради которого метрика и заводится. */
export const MAX_POLARITY_LIFT = 0.3
export const MAX_POLARITY_DROP = 0.5

/** Пока у канала меньше стольких созревших постов, медиана доли репостов недостоверна. */
export const MIN_MATURED_POSTS = 5

/** Максимальная добавка за репосты. Репост — самое дорогое действие читателя, но он
 * коррелирует с просмотрами, поэтому вклад ограничен сильнее просмотрового у видео. */
export const MAX_FORWARD_BOOST = 0.6

/** Вариационный селектор emoji (❤️ против ❤) приходит от Telegram непредсказуемо. */
function normalizeEmoji(emoticon) {
  return String(emoticon).replace(/️/g, "")
}

/**
 * Сворачивает MessageReactions в счётчики для хранения. Кастомные эмодзи (ReactionCustomEmoji)
 * несут только documentId — без отдельного запроса их не опознать, поэтому они копятся
 * в отдельное поле и в полярности не участвуют. По данным это 3 канала из 39.
 * @returns {{ e: Record<string, number>, c: number } | null} null — реакций нет вовсе.
 */
export function summarizeReactions(reactions) {
  const results = reactions?.results
  if (!Array.isArray(results) || results.length === 0) return null

  const e = {}
  let c = 0
  for (const rc of results) {
    const count = rc?.count || 0
    if (count <= 0) continue
    const emoticon = rc.reaction?.className === "ReactionEmoji" ? rc.reaction.emoticon : null
    if (emoticon) {
      const key = normalizeEmoji(emoticon)
      e[key] = (e[key] || 0) + count
    } else {
      c += count
    }
  }
  if (Object.keys(e).length === 0 && c === 0) return null
  return { e, c }
}

export function serializeReactions(summary) {
  return summary ? JSON.stringify(summary) : null
}

/** Хранимый JSON обратно в объект. Битая строка — это отсутствие данных, а не падение дайджеста. */
export function parseReactions(json) {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== "object" || typeof parsed.e !== "object") return null
    return { e: parsed.e || {}, c: parsed.c || 0 }
  } catch {
    return null
  }
}

/**
 * Перевес плюсовых реакций над минусовыми, от -1 до 1. null — «нет данных»: реакций нет,
 * они все кастомные либо их слишком мало. Нейтральные (😁, 🤔) в знаменатель не входят:
 * иначе смешной пост с одним 👎 выглядел бы почти нейтральным по чистой арифметике.
 */
export function computePolarity(summary) {
  if (!summary || !summary.e) return null
  let positive = 0
  let negative = 0
  for (const [emoticon, count] of Object.entries(summary.e)) {
    const sign = POLARITY.get(emoticon)
    if (sign === 1) positive += count
    else if (sign === -1) negative += count
  }
  const classified = positive + negative
  if (classified < MIN_POLARITY_REACTIONS) return null
  return (positive - negative) / classified
}

/** Множитель к скору. Ровно 1, когда данных нет — пост со скрытыми или кастомными
 * реакциями не должен ни выигрывать, ни проигрывать из-за настроек канала. */
export function computePolarityFactor(polarity) {
  if (polarity === null || polarity === undefined || Number.isNaN(polarity)) return 1
  const clamped = Math.max(-1, Math.min(1, polarity))
  return clamped >= 0 ? 1 + MAX_POLARITY_LIFT * clamped : 1 + MAX_POLARITY_DROP * clamped
}

/** Доля репостнувших. null — данных нет: канал запретил пересылку либо просмотров ещё нет. */
export function forwardRatio(forwards, views) {
  if (forwards === null || forwards === undefined) return null
  if (!views || views <= 0) return null
  if (forwards < 0) return null
  return forwards / views
}

/**
 * Как и у видео, считается превышение над медианой канала, а не абсолютная доля: по
 * замеру доли репостов лежат в узкой полосе 0.26%…2.63%, так что абсолютный порог
 * отдал бы буст каналу, а не посту. Умеет только поднимать.
 */
export function computeForwardBoost(forwards, views, medianForwardRatio, maturedCount) {
  if (!(maturedCount >= MIN_MATURED_POSTS)) return 0
  if (!medianForwardRatio || medianForwardRatio <= 0) return 0
  const ratio = forwardRatio(forwards, views)
  if (ratio === null || ratio <= 0) return 0
  const rel = ratio / medianForwardRatio
  if (rel <= 1) return 0
  return Math.min(Math.log10(rel), 1) * MAX_FORWARD_BOOST
}
