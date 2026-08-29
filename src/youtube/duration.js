/** Шортсом считается ролик не длиннее минуты — по нему же YouTube разделяет форматы. */
export const SHORT_MAX_SEC = 60

const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

export function parseISODuration(value) {
  if (!value || typeof value !== "string") return 0
  const m = ISO_DURATION.exec(value)
  if (!m) return 0
  const [, d, h, min, s] = m
  return (
    (parseInt(d, 10) || 0) * 86400 +
    (parseInt(h, 10) || 0) * 3600 +
    (parseInt(min, 10) || 0) * 60 +
    (parseInt(s, 10) || 0)
  )
}

export function isShort(durationSec) {
  return durationSec > 0 && durationSec <= SHORT_MAX_SEC
}
