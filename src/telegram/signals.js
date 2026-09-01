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

/**
 * Насколько сильно негатив опускает скор. Подъёма нет вовсе, и это вывод из данных:
 * за сутки на 44 постах не нашлось ни одного с отрицательным перевесом, все 17 постов
 * с вердиктом получили ровно +1.00. То есть «подъём за полярность» на живой ленте
 * означал бы просто «набрал 20 реакций» — то же самое, что просмотры, только хуже.
 */
export const MAX_POLARITY_DROP = 0.5

/**
 * Часть каналов использует реакции как голосовалку: у leadgr посты штатно собирают
 * 👎 наравне с 👍, а gleb_pro_ai прямым текстом просит «накидайте бустов, голосовалку
 * эмоджиками». Там 👎 означает «не согласен», а не «плохой пост». Поэтому доля негатива
 * сравнивается не с нулём, а с собственной нормой канала — как и все остальные метрики здесь.
 */
export const MIN_NEGATIVE_BASELINE = 0.05

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
 * Доля негатива среди классифицированных реакций, от 0 до 1. null — «нет данных»:
 * реакций нет, они все кастомные либо их слишком мало. Нейтральные (😁, 🤔) не в
 * знаменателе: иначе смешной пост с одним 👎 выглядел бы почти безупречным.
 */
export function negativeShare(summary) {
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
  return negative / classified
}

/**
 * Множитель к скору: 1, пока негатива не больше обычного для канала, и вниз до
 * 1 - MAX_POLARITY_DROP, когда пост собрал негатив почти целиком. Единственная метрика
 * в проекте, умеющая опускать: пост, набравший охват через 💩 и 🤡, — ровно тот случай,
 * который просмотры и репосты принимают за успех.
 */
export function computePolarityFactor(share, baseline = 0) {
  if (share === null || share === undefined || Number.isNaN(share)) return 1
  const floor = Math.max(baseline || 0, MIN_NEGATIVE_BASELINE)
  if (share <= floor) return 1
  const excess = (share - floor) / (1 - floor)
  return 1 - MAX_POLARITY_DROP * Math.min(1, excess)
}

/**
 * Пока у канала меньше стольких созревших постов, верхний дециль не на чем считать.
 * Выше, чем у видео: по пяти точкам «p90» — это просто максимум.
 */
export const MIN_MATURED_POSTS = 10

/** Максимальная добавка за репосты. Репост — самое дорогое действие читателя, но он
 * коррелирует с просмотрами, поэтому вклад ограничен сильнее просмотрового у видео. */
export const MAX_FORWARD_BOOST = 0.6

/** Доля репостнувших. null — данных нет: канал запретил пересылку либо просмотров ещё нет. */
export function forwardRatio(forwards, views) {
  if (forwards === null || forwards === undefined) return null
  if (!views || views <= 0) return null
  if (forwards < 0) return null
  return forwards / views
}

/**
 * Норма канала — верхний дециль его же постов, а не медиана. Медиана как порог по
 * определению пропускает половину ленты: на живых данных она поднимала 60% постов, то
 * есть не отличала ничего. p90 поднимает 19% — и это уже «заметный пост», а не «любой
 * выше среднего». Умеет только поднимать.
 */
export function computeForwardBoost(forwards, views, forwardNorm, maturedCount) {
  if (!(maturedCount >= MIN_MATURED_POSTS)) return 0
  if (!forwardNorm || forwardNorm <= 0) return 0
  const ratio = forwardRatio(forwards, views)
  if (ratio === null || ratio <= 0) return 0
  const rel = ratio / forwardNorm
  if (rel <= 1) return 0
  return Math.min(Math.log10(rel), 1) * MAX_FORWARD_BOOST
}
