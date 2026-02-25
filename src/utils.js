/**
 * Форматирование сообщений и пагинация.
 */

const DIGEST_PAGE_SIZE = 10;

/**
 * Обрезает текст до maxLen, добавляет многоточие при необходимости.
 */
export function truncate(text, maxLen = 300) {
  if (!text || typeof text !== "string") return "";
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 3).trim() + "...";
}

/**
 * Форматирует один пункт дайджеста: канал, описание, ссылка.
 */
export function formatDigestItem(index, post, reason = "") {
  const channel = post.channel || "channel";
  const desc = truncate(post.text, 200);
  const link = post.link || `https://t.me/${channel}/${post.post_id}`;
  const reasonLine = reason ? `\n   ✦ ${reason}` : "";
  return `${index}. **${channel}**\n${desc}\n[Open →](${link})${reasonLine}`;
}

/**
 * Собирает текст дайджеста для постов с offset и limit.
 */
export function formatDigestPage(posts, reasonsMap = {}, offset = 0) {
  const lines = posts.map((p, i) => formatDigestItem(offset + i + 1, p, reasonsMap[p.id]));
  return lines.join("\n\n");
}

/**
 * Возвращает offset для страницы (0-based page index).
 */
export function getOffsetForPage(pageIndex) {
  return Math.max(0, pageIndex) * DIGEST_PAGE_SIZE;
}

export { DIGEST_PAGE_SIZE };

/**
 * Форматирует список каналов для вывода.
 */
export function formatChannelList(channels) {
  if (!channels || channels.length === 0) return "No channels yet. Add via /add @channel or forward a post from a channel.";
  return channels.map((c) => `• @${c.username}`).join("\n");
}

/**
 * Последние N дней для кнопок выбора даты (summary).
 */
export function getLastDays(count = 7) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({
      date: d.toISOString().slice(0, 10),
      label: formatDateLabel(d)
    });
  }
  return days;
}

export function formatDateLabel(date) {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getDate();
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}
