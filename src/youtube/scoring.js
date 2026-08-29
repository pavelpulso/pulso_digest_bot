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
  if (maturedCount < MIN_MATURED_VIDEOS) return 0
  if (!medianViews || medianViews <= 0) return 0
  if (!views || views <= 0) return 0
  const ratio = views / medianViews
  if (ratio <= 1) return 0
  return Math.min(Math.log10(ratio), 1)
}
