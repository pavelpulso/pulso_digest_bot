/** Пока у канала меньше стольких созревших видео, медиана недостоверна. */
export const MIN_MATURED_VIDEOS = 5

export function median(values) {
  if (!values || values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Метрика умеет только поднимать скор. Видео, вышедшее вчера, физически не успело
 * набрать просмотры — если позволить метрике опускать, свежее всегда проиграет
 * недельному и «топ за 7 дней» станет «топом прошлой недели».
 */
export function computeBoost(views, medianViews, maturedCount) {
  if (!(maturedCount >= MIN_MATURED_VIDEOS)) return 0
  if (!medianViews || medianViews <= 0) return 0
  if (!views || views <= 0) return 0
  const ratio = views / medianViews
  if (ratio <= 1) return 0
  return Math.min(Math.log10(ratio), 1)
}

/** Ниже этого числа просмотров доля лайков — шум: 200 просмотров и 30 лайков от ядра
 * подписчиков дают 15%, чего видео никогда не удержит на дистанции. */
export const MIN_VIEWS_FOR_LIKE_RATIO = 500

/** Пока у канала меньше стольких видео с известными лайками, медиана доли недостоверна. */
export const MIN_LIKE_RATIO_SAMPLES = 5

/** Максимальная добавка от лайков. Вдвое меньше просмотровой: доля лайков — сигнал о
 * качестве, но её легче накрутить и она сильнее зависит от жанра. */
export const MAX_LIKE_BOOST = 0.5

/**
 * Доля лайков от просмотров. null — «нет данных»: автор скрыл лайки либо просмотров
 * слишком мало, чтобы доля что-то значила. Ноль лайков при живых просмотрах — данные,
 * а не отсутствие данных, поэтому это 0, а не null.
 */
export function likeRatio(likes, views) {
  if (likes === null || likes === undefined) return null
  if (!views || views < MIN_VIEWS_FOR_LIKE_RATIO) return null
  if (likes < 0) return null
  return likes / views
}

/**
 * Считает не абсолютную долю лайков, а превышение над медианой канала: у разных аудиторий
 * своя норма лайкать, и без нормировки boost достался бы жанру, а не видео. Как и
 * просмотровая метрика, умеет только поднимать — иначе видео со скрытыми лайками или
 * свежее, ещё не набравшее просмотров, проигрывало бы просто из-за отсутствия данных.
 */
export function computeLikeBoost(likes, views, medianLikeRatio, likeRatioCount) {
  if (!(likeRatioCount >= MIN_LIKE_RATIO_SAMPLES)) return 0
  if (!medianLikeRatio || medianLikeRatio <= 0) return 0
  const ratio = likeRatio(likes, views)
  if (ratio === null || ratio <= 0) return 0
  const rel = ratio / medianLikeRatio
  if (rel <= 1) return 0
  return Math.min(Math.log10(rel), 1) * MAX_LIKE_BOOST
}
