/**
 * Message formatting and pagination utilities.
 */

export const DIGEST_PAGE_SIZE = 10
export const MAX_MESSAGE_LEN = 4096

/** Minimum post score for digest inclusion (posts below are excluded). */
export const MIN_DIGEST_SCORE = 0.5

/**
 * Truncates text to maxLen, adds ellipsis if needed.
 */
export function truncate(text, maxLen = 300) {
  if (!text || typeof text !== "string") return ""
  const t = text.trim()
  if (t.length <= maxLen) return t
  return t.slice(0, maxLen - 3).trim() + "..."
}

/**
 * Formats a single digest item: channel, description, link.
 */
export function formatDigestItem(index, post, reason = "") {
  const channel = post.channel || "channel"
  const desc = truncate(post.text, 200)
  const link = post.link || `https://t.me/${channel}/${post.post_id}`
  const reasonLine = reason ? `\n   ✦ ${reason}` : ""
  return `${index}. **${channel}**\n${desc}\n[Open →](${link})${reasonLine}`
}

/**
 * Builds digest text for posts with offset and limit.
 */
export function formatDigestPage(posts, reasonsMap = {}, offset = 0) {
  const lines = posts.map((p, i) => formatDigestItem(offset + i + 1, p, reasonsMap[p.id]))
  return lines.join("\n\n")
}

/**
 * Returns offset for page (0-based page index).
 */
export function getOffsetForPage(pageIndex) {
  return Math.max(0, pageIndex) * DIGEST_PAGE_SIZE
}


/**
 * Formats channel list for display.
 */
export function formatChannelList(channels) {
  if (!channels || channels.length === 0) return "No channels yet. Add via /add @channel or forward a post from a channel."
  return channels.map((c) => `• @${c.username}`).join("\n")
}

/**
 * Returns the digest date based on current time.
 * Digest day starts at 06:00 MSK (03:00 UTC in winter, 04:00 UTC in summer).
 * 
 * Logic:
 * - If current time in Moscow is BEFORE 06:00 MSK → digest date = yesterday
 * - If current time in Moscow is 06:00 MSK or later → digest date = today
 * 
 * This ensures morning digest at 07:00 MSK contains posts from 06:00 yesterday to 06:00 today.
 */
export function getDigestDate() {
  const now = new Date()
  
  // Get current time in Moscow (UTC+3)
  const moscowTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Moscow" }))
  
  // Check if it's before 06:00 MSK
  const moscowHour = moscowTime.getHours()
  const moscowMinute = moscowTime.getMinutes()
  const isBeforeSixAM = moscowHour < 6 || (moscowHour === 6 && moscowMinute < 0)
  
  // Get digest date: if before 06:00 MSK → yesterday, else → today
  const digestDate = new Date(moscowTime)
  if (isBeforeSixAM) {
    digestDate.setDate(digestDate.getDate() - 1)
  }
  
  // Return date in YYYY-MM-DD format (UTC date that corresponds to Moscow date)
  return digestDate.toISOString().slice(0, 10)
}

/**
 * Last N days for date selection buttons (summary).
 */
export function getLastDays(count = 7) {
  const days = []
  for (let i = 0; i < count; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    days.push({
      date: d.toISOString().slice(0, 10),
      label: formatDateLabel(d)
    })
  }
  return days
}

export function formatDateLabel(date) {
  const d = date instanceof Date ? date : new Date(date)
  const day = d.getDate()
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")
  const month = months[d.getMonth()]
  const year = d.getFullYear()
  return `${day} ${month} ${year}`
}

/** Date range label, e.g. "19–25 Feb 2026". */
export function formatDateRangeLabel(sinceDate, untilDate) {
  const since = sinceDate instanceof Date ? sinceDate : new Date(sinceDate)
  const until = untilDate instanceof Date ? untilDate : new Date(untilDate)
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")
  const sameMonth = since.getMonth() === until.getMonth() && since.getFullYear() === until.getFullYear()
  if (sameMonth) {
    return `${since.getDate()}–${until.getDate()} ${months[until.getMonth()]} ${until.getFullYear()}`
  }
  return `${since.getDate()} ${months[since.getMonth()]} – ${until.getDate()} ${months[until.getMonth()]} ${until.getFullYear()}`
}
