import { Telegraf, Markup } from "telegraf"
import {
  getOrCreateUser,
  getUser,
  isUserBanned,
  isBotOpen,
  setBotOpen,
  getChannels,
  getChannelUsernames,
  addChannel,
  removeChannel,
  getPostsLast24h,
  getPostsByIds,
  getRankedPostIds,
  getRankingsMap,
  clearRankingsForUser,
  insertRankings,
  updateUserProfile,
  updateUserDigestMax,
  updateUserMinusKeywords,
  getUserMinusKeywords,
  getUserHiddenChannels,
  getUserChannelPriorities,
  toggleUserChannelHidden,
  cycleUserChannelPriority,
  setUserChannelPriority,
  getUserChannelSettings,
  banUserByUsernameOrId,
  unbanUserByUsernameOrId,
  getStats,
  getPostsForDateRange,
  getUsersForMorningDigest,
  getPostFeedbackForRanking,
  upsertPostFeedback,
  getRankedPostIdsAboveScore,
  getRankedPostIdsWithTotal,
  getRankingByUserAndPost,
  getDigestFormat,
  setDigestFormat
} from "./db.js"
import { collectChannelPosts } from "./gramjs.js"
import { rankPosts, generateSummaryBlocks, recommendChannels } from "./gemini.js"
import {
  formatChannelList,
  getLastDays,
  formatDateLabel,
  formatDateRangeLabel,
  DIGEST_PAGE_SIZE,
  MIN_DIGEST_SCORE
} from "./utils.js"
import { v4 as uuidv4 } from "uuid"

const BOT_TOKEN = process.env.BOT_TOKEN
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10)

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required")

const bot = new Telegraf(BOT_TOKEN)

const pendingAddChannels = new Map()
const pendingMinusWords = new Map()

/** Ответ на callback_query без падения при "query is too old". */
async function safeAnswerCbQuery(ctx, text) {
  try {
    await ctx.answerCbQuery(text)
  } catch (_) { }
}

const MENU_BTN_DIGEST = "📰 Digest"
const MENU_BTN_SUMMARY = "📋 Summary"
const MENU_BTN_CHANNELS = "📢 Channels"
const MENU_BTN_PROFILE = "👤 Profile"
const MENU_BTN_MENU = "📱 Menu"

function mainReplyKeyboard() {
  return Markup.keyboard([
    [MENU_BTN_DIGEST, MENU_BTN_SUMMARY],
    [MENU_BTN_CHANNELS, MENU_BTN_PROFILE],
    [MENU_BTN_MENU]
  ]).resize()
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📰 Digest", "digest"),
      Markup.button.callback("📋 Summary", "summary"),
      Markup.button.callback("📢 Channels", "channels")
    ],
    [
      Markup.button.callback("👤 Profile", "profile"),
      Markup.button.callback("➕ Add channel", "add_channels"),
      Markup.button.callback("➖ Remove channel", "remove_channel")
    ]
  ])
}

function channelsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("➕ Add channel", "add_channels"),
      Markup.button.callback("➖ Remove channel", "remove_channel")
    ],
    [Markup.button.callback("⚙ Channel settings", "channel_settings")]
  ])
}

function todayDate() {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

/**
 * ID постов для дайджеста: только с score >= MIN_DIGEST_SCORE.
 * Если таких меньше 3 — возвращаем топ-3 без порога (чтобы дайджест не был пустым).
 * @returns {{ postIds: string[], total: number }}
 */
function getDigestPostIdsForUser(userId, date, limit, offset) {
  const idsAbove = getRankedPostIdsAboveScore(userId, date, MIN_DIGEST_SCORE, 10000, 0)
  const allIds = idsAbove.length < 3 ? getRankedPostIds(userId, date, 10000, 0) : idsAbove
  return {
    postIds: allIds.slice(offset, offset + limit),
    total: allIds.length
  }
}

function isAdmin(userId) {
  return Number.isInteger(ADMIN_ID) && userId === ADMIN_ID
}

function formatErrorForChat(e) {
  const raw = (e && (e.message || e.reason)) || String(e)
  const oneLine = raw.replace(/\s+/g, " ").trim()
  return oneLine.length > 250 ? oneLine.slice(0, 247) + "…" : oneLine
}

function isAdPost(post) {
  const t = (post.text || "").toLowerCase()
  return (t.includes("реклама") && (t.includes("инн") || t.includes("erid")))
}

function formatCollectAnalytics({ collected, perChannel = [], errors = [] }) {
  const channelLines = (perChannel || []).map(
    (p) => `@${p.channel} ${"error" in p && p.error ? `— ${p.error}` : p.count + " posts"}`
  )
  let text = `Collected: ${collected} posts.`
  if (channelLines.length) text += "\nChannels: " + channelLines.join("; ")
  if (errors.length) text += "\n\nErrors: " + errors.join("; ")
  return text
}

const MAX_MESSAGE_LEN = 4096

/** Экранирует символы Markdown в тексте (для заголовков). */
function escapeMarkdown(text) {
  if (!text || typeof text !== "string") return ""
  return text.replace(/([*_`\[\]])/g, "\\$1")
}

/** Заголовок дайджеста в HTML (избегает ошибок parse entities в Markdown). */
function formatDigestHeader(label, teaser, count, opts = {}) {
  const suffix = opts.morning ? "\n\n<i>/digest — ещё постов</i>" : ""
  const safeLabel = escapeHtml(label)
  const safeTeaser = teaser ? escapeHtml(teaser) : ""
  if (safeTeaser) {
    return `📰 <b>Дайджест за ${safeLabel}</b>\n\n<b>Главное:</b> ${safeTeaser}\n\n(${count} пунктов)${suffix}`.trim()
  }
  return `📰 <b>Дайджест за ${safeLabel}</b> (${count} пунктов)${suffix}`.trim()
}

/** Экранирует HTML: для отображения текста от Gemini в parse_mode: HTML. */
function escapeHtml(text) {
  if (!text || typeof text !== "string") return ""
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function buildPostById(posts) {
  return Object.fromEntries(
    posts.map((p) => {
      const postUrl =
        p.link && String(p.link).endsWith("/" + p.post_id) ? p.link : `https://t.me/${p.channel}/${p.post_id}`
      return [p.id, { channel: p.channel, postUrl }]
    })
  )
}

/**
 * Формат блока: суть → действие → потенциал → ссылки.
 * compact: только суть + ссылки (гипотеза #37).
 */
function formatBlockText(block, postById, useHtml = true, options = {}) {
  const { compact = false } = options
  const e = useHtml ? escapeHtml : (t) => t || ""
  const essence = e(block.essence)
  const potential = e(block.potential)
  const action = e(block.action || "")
  let linksLine
  if (block.ids.length === 1) {
    const { channel, postUrl } = postById[block.ids[0]] || { channel: "channel", postUrl: "#" }
    const safeUrl = postUrl.replace(/&/g, "&amp;")
    linksLine = useHtml
      ? `<a href="${safeUrl}">↗ @${escapeHtml(channel)}</a>`
      : `[↗ @${channel}](${postUrl})`
  } else {
    const parts = block.ids.map((id) => {
      const { channel, postUrl } = postById[id] || { channel: "channel", postUrl: "#" }
      const safeUrl = postUrl.replace(/&/g, "&amp;")
      return useHtml
        ? `<a href="${safeUrl}">@${escapeHtml(channel)}</a>`
        : `[@${channel}](${postUrl})`
    })
    linksLine = useHtml ? parts.join(" · ") : parts.join(", ")
  }
  if (compact) {
    const text = `${block.emoji} ${essence}\n\n${linksLine}`
    return text.length > MAX_MESSAGE_LEN ? text.slice(0, MAX_MESSAGE_LEN - 1) + "…" : text
  }
  const actionLine =
    action && useHtml ? `⚡ <b>${action}</b>` : action ? `⚡ ${action}` : null
  const lines = [
    `${block.emoji} ${essence}`,
    ...(actionLine ? [actionLine] : []),
    ...(potential ? [`💡 ${potential}`] : []),
    linksLine
  ]
  const text = lines.join("\n\n")
  return text.length > MAX_MESSAGE_LEN ? text.slice(0, MAX_MESSAGE_LEN - 1) + "…" : text
}

/** Inline-кнопки для блока с одним постом: feedback + опционально «Подробнее» (гипотеза #38). */
function blockKeyboard(postId, hasWhy = false) {
  if (!postId) return undefined
  const row = [
    { text: "👍 Релевантно", callback_data: `fb:${postId}:1` },
    { text: "👎 Не релевантно", callback_data: `fb:${postId}:-1` }
  ]
  if (hasWhy) row.push({ text: "📌 Подробнее", callback_data: `why:${postId}` })
  return {
    reply_markup: {
      inline_keyboard: [row]
    }
  }
}

function filterPostsForUser(posts, userId) {
  const hidden = new Set(getUserHiddenChannels(userId).map((c) => c.toLowerCase()))
  const minusKeywords = getUserMinusKeywords(userId)
  return posts.filter((p) => {
    if (hidden.has((p.channel || "").toLowerCase())) return false
    if (minusKeywords.length === 0) return true
    const text = (p.text || "").toLowerCase()
    const hasMinus = minusKeywords.some((kw) => text.includes(kw))
    return !hasMinus
  })
}

async function ensureRankingsForUser(userId, userProfile) {
  const date = todayDate()
  const existing = getRankedPostIds(userId, date, 1)
  if (existing.length > 0) return

  const allPosts = getPostsLast24h()
  const posts = filterPostsForUser(allPosts, userId)
  if (posts.length === 0) return

  const channelPriorities = getUserChannelPriorities(userId)
  const feedback = getPostFeedbackForRanking(userId)
  try {
    const ranked = await rankPosts(posts, userProfile, {
      channelPriorities,
      feedback
    })
    clearRankingsForUser(userId, date)
    const items = ranked.map((r) => ({
      id: uuidv4(),
      post_id: r.post_id,
      score: r.score,
      reason: r.reason
    }))
    insertRankings(userId, date, items)
  } catch (e) {
    console.error("Gemini rank error:", e)
    throw e
  }
}

/** Ранжирует переданные посты для пользователя и даты. Возвращает количество ранжированных. */
async function ensureRankingsForUserAndPosts(userId, date, posts, userProfile) {
  const existing = getRankedPostIds(userId, date, 1)
  if (existing.length > 0) return posts.length

  if (posts.length === 0) return 0

  const channelPriorities = getUserChannelPriorities(userId)
  const feedback = getPostFeedbackForRanking(userId)
  try {
    const ranked = await rankPosts(posts, userProfile, {
      channelPriorities,
      feedback
    })
    clearRankingsForUser(userId, date)
    const items = ranked.map((r) => ({
      id: uuidv4(),
      post_id: r.post_id,
      score: r.score,
      reason: r.reason
    }))
    insertRankings(userId, date, items)
    return ranked.length
  } catch (e) {
    console.error("Gemini rank error:", e)
    throw e
  }
}

async function digestReply(ctx, offset = 0, count = DIGEST_PAGE_SIZE) {
  const userId = ctx.from?.id
  if (!userId) return ctx.reply("Error: unknown user.")

  const date = todayDate()
  const { postIds, total: totalRanked } = getDigestPostIdsForUser(userId, date, count, offset)
  if (postIds.length === 0) {
    const noPostsText =
      "No posts for today or ranking not ready yet. Try later or add channels via /add or by forwarding a post."
    const hasChannels = getChannelUsernames().length > 0
    const keyboard = hasChannels
      ? Markup.inlineKeyboard([[Markup.button.callback("Fetch posts and show digest", "fetch_then_digest")]])
      : undefined
    return ctx.reply(noPostsText, keyboard)
  }

  const posts = getPostsByIds(postIds)
  const orderMap = {}
  postIds.forEach((id, i) => (orderMap[id] = i))
  posts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

  const user = getOrCreateUser(userId)
  const label = formatDateLabel(date)
  const maxItems = Math.min(20, Math.max(3, user.digest_max_items ?? 7))
  const optsMd = { parse_mode: "Markdown", disable_web_page_preview: true }
  const optsHtml = { parse_mode: "HTML", disable_web_page_preview: true }

  const loadingMsg = await ctx.reply("Формирую дайджест…")
  let teaser = null
  let blocks = []
  let postById = {}
  try {
    const result = await generateSummaryBlocks(posts, label, user.profile || "", maxItems)
    teaser = result.teaser
    blocks = result.blocks
    postById = buildPostById(posts)
  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { })
    return ctx.reply("Не удалось сформировать дайджест. Попробуйте позже.\n\n" + formatErrorForChat(e))
  }
  await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { })

  const hasMore = offset + count < totalRanked
  const row = []
  if (hasMore) {
    const nextOffset = offset + count
    row.push({ text: "▶️ Ещё 5", callback_data: `more:${nextOffset}:5` })
    row.push({ text: "▶️ Ещё 10", callback_data: `more:${nextOffset}:10` })
  }
  row.push({ text: "📋 Summary", callback_data: "summary" })

  const rankMap = getRankingsMap(userId, date)
  const compact = getDigestFormat(userId) === "compact"
  const header = formatDigestHeader(label, teaser, blocks.length)
  await ctx.telegram.sendMessage(ctx.chat.id, header, {
    ...optsHtml,
    reply_markup: { inline_keyboard: [row] }
  })
  await ctx.telegram.sendMessage(ctx.chat.id, "<b>Главное для тебя:</b>", optsHtml)
  for (const block of blocks) {
    const blockOpts =
      block.ids.length === 1
        ? { ...optsHtml, ...blockKeyboard(block.ids[0], !!rankMap[block.ids[0]]?.reason) }
        : optsHtml
    await ctx.telegram.sendMessage(
      ctx.chat.id,
      formatBlockText(block, postById, true, { compact }),
      blockOpts
    )
  }
}

/**
 * Строит блоки дайджеста для пользователя (первая страница) — для утренней рассылки.
 * @returns {Promise<{ header: string, teaser: string|null, blocks: Array, postById: Object, rankMap: Object } | null>}
 */
async function buildDigestBlocks(userId) {
  const date = todayDate()
  const { postIds, total: _total } = getDigestPostIdsForUser(userId, date, DIGEST_PAGE_SIZE, 0)
  if (postIds.length === 0) return null
  const posts = getPostsByIds(postIds)
  const orderMap = {}
  postIds.forEach((id, i) => (orderMap[id] = i))
  posts.sort((a, b) => orderMap[a.id] - orderMap[b.id])
  const user = getOrCreateUser(userId)
  const label = formatDateLabel(date)
  const maxItems = Math.min(20, Math.max(3, user.digest_max_items ?? 7))
  try {
    const result = await generateSummaryBlocks(posts, label, user.profile || "", maxItems)
    if (!result.blocks || result.blocks.length === 0) return null
    const postById = buildPostById(posts)
    const rankMap = getRankingsMap(userId, date)
    const header = formatDigestHeader("утро", result.teaser, result.blocks.length, { morning: true })
    return {
      header,
      teaser: result.teaser || null,
      blocks: result.blocks,
      postById,
      rankMap
    }
  } catch (e) {
    console.error("[buildDigestBlocks] user", userId, e.message || e)
    return null
  }
}

/**
 * Отправляет summary блоки с пагинацией.
 * @param {object} ctx - Telegraf context
 * @param {string} dateStr - дата в формате YYYY-MM-DD
 * @param {string} label - метка для заголовка
 * @param {number} offset - смещение для пагинации
 * @param {object} options - { maxItems, chatId?, messageToEdit? }
 */
async function sendSummaryBlocks(ctx, dateStr, label, offset = 0, options = {}) {
  const userId = ctx.from?.id
  if (!userId) return
  const user = getOrCreateUser(userId)
  const maxItems = options.maxItems || Math.min(20, Math.max(3, user.digest_max_items ?? 7))
  const chatId = options.chatId || ctx.chat?.id
  if (!chatId) return

  const optsHtml = { parse_mode: "HTML", disable_web_page_preview: true }

  // Получаем посты за дату
  const since = `${dateStr}T00:00:00.000Z`
  const until = new Date(new Date(since).getTime() + 24 * 60 * 60 * 1000).toISOString()
  let posts = getPostsForDateRange(since, until)
  posts = posts.filter((p) => !isAdPost(p))
  posts = filterPostsForUser(posts, userId)

  if (posts.length === 0) {
    return ctx.telegram.sendMessage(chatId, "No posts for the selected day.")
  }

  // Ранжируем посты если нужно
  await ensureRankingsForUserAndPosts(userId, dateStr, posts, user.profile || "")

  // Получаем ранжированные посты с пагинацией
  const { postIds, total } = getRankedPostIdsWithTotal(userId, dateStr, maxItems, offset, 0)
  if (postIds.length === 0) {
    return ctx.telegram.sendMessage(chatId, "No ranked posts for the selected day.")
  }

  const rankedPosts = getPostsByIds(postIds)
  const orderMap = {}
  postIds.forEach((id, i) => (orderMap[id] = i))
  rankedPosts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

  // Генерируем блоки
  let teaser = null
  let blocks = []
  let postById = {}
  try {
    const result = await generateSummaryBlocks(rankedPosts, label, user.profile || "", maxItems)
    teaser = result.teaser
    blocks = result.blocks
    postById = buildPostById(rankedPosts)
  } catch (e) {
    return ctx.telegram.sendMessage(chatId, "Failed to generate summary blocks.\n\n" + formatErrorForChat(e))
  }

  if (blocks.length === 0) {
    return ctx.telegram.sendMessage(chatId, `📋 Дайджест за ${label}\n\nНе удалось сформировать блоки.`)
  }

  // Удаляем сообщение "Generating..." если есть
  if (options.messageToEdit) {
    await ctx.telegram.deleteMessage(chatId, options.messageToEdit).catch(() => { })
  }

  // Отправляем заголовок
  const header = formatDigestHeader(label, teaser, blocks.length)
  const hasMore = offset + maxItems < total
  const row = []
  if (hasMore) {
    row.push({ text: `▶️ Ещё ${maxItems}`, callback_data: `summary_more:${dateStr}:${offset + maxItems}:${maxItems}` })
  }
  row.push({ text: "📋 Меню", callback_data: "menu" })

  await ctx.telegram.sendMessage(chatId, header, {
    ...optsHtml,
    reply_markup: { inline_keyboard: [row] }
  })

  // Отправляем блоки
  const rankMap = getRankingsMap(userId, dateStr)
  const compact = getDigestFormat(userId) === "compact"
  for (const block of blocks) {
    const blockOpts =
      block.ids.length === 1
        ? { ...optsHtml, ...blockKeyboard(block.ids[0], !!rankMap[block.ids[0]]?.reason) }
        : optsHtml
    await ctx.telegram.sendMessage(chatId, formatBlockText(block, postById, true, { compact }), blockOpts)
  }
}

/**
 * Рассылает утренний дайджест всем пользователям (вызывается из cron).
 * Сначала — push с тизером и кнопкой «Открыть дайджест», затем заголовок и блоки.
 * @param {import("telegraf").Telegraf} botInstance
 */
export async function sendMorningDigests(botInstance) {
  const users = getUsersForMorningDigest()
  if (users.length === 0) return
  const optsHtml = { parse_mode: "HTML", disable_web_page_preview: true }
  for (const u of users) {
    try {
      await ensureRankingsForUser(u.user_id, u.profile || "")
      const payload = await buildDigestBlocks(u.user_id)
      if (payload) {
        const teaserText =
          payload.header && payload.teaser
            ? `☀️ <b>Главное утром:</b> ${escapeHtml(payload.teaser)}\n\n<i>Открой дайджест — ниже полный разбор.</i>`
            : "☀️ Дайджест готов. Открой ниже."
        const teaserKeyboard = {
          reply_markup: {
            inline_keyboard: [[{ text: "📰 Открыть дайджест", callback_data: "digest" }]]
          }
        }
        await botInstance.telegram.sendMessage(u.user_id, teaserText, {
          ...optsHtml,
          ...teaserKeyboard
        })
        await botInstance.telegram.sendMessage(u.user_id, payload.header, optsHtml)
        await botInstance.telegram.sendMessage(u.user_id, "<b>Главное для тебя:</b>", optsHtml)
        const compact = getDigestFormat(u.user_id) === "compact"
        for (const block of payload.blocks) {
          const blockOpts =
            block.ids.length === 1
              ? { ...optsHtml, ...blockKeyboard(block.ids[0], !!payload.rankMap[block.ids[0]]?.reason) }
              : optsHtml
          await botInstance.telegram.sendMessage(
            u.user_id,
            formatBlockText(block, payload.postById, true, { compact }),
            blockOpts
          )
        }
      }
    } catch (e) {
      console.error("[morning digest] user", u.user_id, e.message || e)
    }
  }
}

bot.use((ctx, next) => {
  const userId = ctx.from?.id
  if (userId) {
    const username = ctx.from?.username ? String(ctx.from.username).toLowerCase() : null
    if (isBotOpen()) getOrCreateUser(userId, username)
    else if (getUser(userId)) getOrCreateUser(userId, username)
  }
  return next()
})

bot.start(async (ctx) => {
  const userId = ctx.from?.id
  if (!userId) return ctx.reply("Error.")

  if (!isBotOpen()) {
    const existing = getUser(userId)
    if (!existing) {
      return ctx.reply("Bot is closed to new users.")
    }
  }

  getOrCreateUser(userId, ctx.from?.username ? String(ctx.from.username).toLowerCase() : null)
  if (isUserBanned(userId)) {
    return ctx.reply("You are blocked.")
  }

  await ctx.reply(
    "Hi! I collect posts from your channels and build a digest.\n\n" +
    "Use the buttons below or:\n" +
    "/digest — top posts for today\n" +
    "/profile — set interests for personalization\n" +
    "/summary — digest for a chosen day\n" +
    "/channels — list of channels\n" +
    "/add @channel — add a channel\n" +
    "/remove @channel — remove a channel\n\n" +
    "You can forward a post from a channel — the channel will be added automatically.",
    mainReplyKeyboard()
  )
  await ctx.reply("Choose an action:", mainMenuKeyboard())
})

bot.command("digest", async (ctx) => {
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return

  const user = getOrCreateUser(userId)
  const date = todayDate()
  const hasRankings = getRankedPostIds(userId, date, 1).length > 0
  if (!hasRankings) {
    const loading = await ctx.reply("Ranking posts for your profile…")
    try {
      await ensureRankingsForUser(userId, user.profile || "")
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        "Failed to get ranking (Gemini error). Try again later.\n\nError: " + formatErrorForChat(e)
      )
      return
    }
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id)
  }
  return digestReply(ctx, 0)
})

bot.action(/^more:(\d+):(\d+)$/, async (ctx) => {
  const offset = parseInt(ctx.match[1], 10)
  const count = parseInt(ctx.match[2], 10)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  await safeAnswerCbQuery(ctx, "Формирую…")

  const date = todayDate()
  const { postIds, total: totalRanked } = getDigestPostIdsForUser(userId, date, count, offset)
  if (postIds.length === 0) {
    return ctx.telegram.sendMessage(ctx.chat.id, "Больше постов нет.")
  }

  const posts = getPostsByIds(postIds)
  const orderMap = {}
  postIds.forEach((id, i) => (orderMap[id] = i))
  posts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

  const user = getOrCreateUser(userId)
  const maxItems = Math.min(20, Math.max(3, user.digest_max_items ?? 7))
  const optsMd = { parse_mode: "Markdown", disable_web_page_preview: true }
  const optsHtml = { parse_mode: "HTML", disable_web_page_preview: true }

  const loadingMsg = await ctx.telegram.sendMessage(ctx.chat.id, "Формирую ещё посты…")
  let blocks = []
  let postById = {}
  try {
    const result = await generateSummaryBlocks(
      posts,
      "Ещё посты",
      user.profile || "",
      maxItems
    )
    blocks = result.blocks
    postById = buildPostById(posts)
  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { })
    return ctx.telegram.sendMessage(ctx.chat.id, "Ошибка: " + formatErrorForChat(e))
  }
  await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { })

  const hasMore = offset + count < totalRanked
  const row = []
  if (hasMore) {
    const nextOffset = offset + count
    row.push({ text: "▶️ Ещё 5", callback_data: `more:${nextOffset}:5` })
    row.push({ text: "▶️ Ещё 10", callback_data: `more:${nextOffset}:10` })
  }
  row.push({ text: "📋 Summary", callback_data: "summary" })

  const rankMap = getRankingsMap(userId, date)
  const compact = getDigestFormat(userId) === "compact"
  const header = `📰 Ещё ${blocks.length} постов`
  await ctx.telegram.sendMessage(ctx.chat.id, header, {
    ...optsMd,
    reply_markup: { inline_keyboard: [row] }
  })
  for (const block of blocks) {
    const blockOpts =
      block.ids.length === 1
        ? { ...optsHtml, ...blockKeyboard(block.ids[0], !!rankMap[block.ids[0]]?.reason) }
        : optsHtml
    await ctx.telegram.sendMessage(
      ctx.chat.id,
      formatBlockText(block, postById, true, { compact }),
      blockOpts
    )
  }
})

bot.action(/^why:(.+)$/, async (ctx) => {
  const postId = ctx.match[1]
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) {
    await safeAnswerCbQuery(ctx)
    return
  }
  const date = todayDate()
  const r = getRankingByUserAndPost(userId, postId, date)
  if (!r?.reason) {
    await safeAnswerCbQuery(ctx, "Объяснение недоступно")
    return
  }
  await safeAnswerCbQuery(ctx)
  await ctx.telegram.sendMessage(ctx.chat.id, `📌 <b>Почему в дайджесте:</b>\n\n${escapeHtml(r.reason)}`, {
    parse_mode: "HTML",
    disable_web_page_preview: true
  })
})

bot.action(/^fb:(.+):(-?1)$/, async (ctx) => {
  const postId = ctx.match[1]
  const rating = parseInt(ctx.match[2], 10)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) {
    await safeAnswerCbQuery(ctx)
    return
  }
  upsertPostFeedback(userId, postId, rating)
  await safeAnswerCbQuery(ctx, "Спасибо, учту")
})

bot.action("digest", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  const user = getOrCreateUser(userId)
  const date = todayDate()
  const hasRankings = getRankedPostIds(userId, date, 1).length > 0
  if (!hasRankings) {
    const loading = await ctx.telegram.sendMessage(ctx.chat.id, "Ranking posts for your profile…")
    try {
      await ensureRankingsForUser(userId, user.profile || "")
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        "Failed to get ranking (Gemini error). Try again later.\n\nError: " + formatErrorForChat(e)
      )
      return
    }
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id)
  }
  await digestReply(ctx, 0)
})

bot.action("fetch_then_digest", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  const chatId = ctx.chat.id

  if (getChannelUsernames().length === 0) {
    await ctx.telegram.sendMessage(chatId, "Add channels first (Channels → Add channel, or forward a post).")
    return
  }

  const statusMsg = await ctx.telegram.sendMessage(
    chatId,
    "Fetching from channels — this may take a minute…"
  )

  let collectResult
  try {
    collectResult = await collectChannelPosts({
      onProgress: async ({ channel, index, total, collected }) => {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          null,
          `Fetching channels: ${index}/${total} @${channel}… (posts collected: ${collected})`
        ).catch(() => { })
      }
    })
  } catch (e) {
    console.error("Fetch then digest collect error:", e)
    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      "Failed to fetch posts.\n\nError: " + formatErrorForChat(e)
    )
    return
  }

  await ctx.telegram.sendMessage(chatId, formatCollectAnalytics(collectResult)).catch(() => { })

  const user = getOrCreateUser(userId)
  try {
    await ensureRankingsForUser(userId, user.profile || "")
  } catch (e) {
    await ctx.telegram.sendMessage(
      chatId,
      "Failed to get ranking.\n\nError: " + formatErrorForChat(e)
    )
    return
  }

  await digestReply(ctx, 0)
})

function summaryDateKeyboard() {
  const days = getLastDays(7)
  const rows = days.map((d) => [{ text: d.label, callback_data: `summary_date:${d.date}` }])
  rows.push([{ text: "📅 Weekly (last 7 days)", callback_data: "summary_weekly" }])
  return { reply_markup: { inline_keyboard: rows } }
}

bot.action("summary", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  await ctx.editMessageText("Choose date for summary:", summaryDateKeyboard())
})

bot.action("channels", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const channels = getChannels()
  await ctx.editMessageText(formatChannelList(channels), channelsKeyboard())
})

function renderProfileText(userId, user) {
  const profileText = user.profile || "not set"
  const minusWords = getUserMinusKeywords(userId)
  const minusLine = minusWords.length > 0 ? `\nMinus words: ${minusWords.join(", ")}` : "\nMinus words: not set."
  const formatText = getDigestFormat(userId) === "compact" ? "compact (essence + link)" : "full"
  const maxDigest = user.digest_max_items ?? 7
  return `Your profile (interests, profession):\n${profileText}\n${minusLine}\nMax digest items: ${maxDigest}\nDigest format: ${formatText}\n\nTo update, send: /profile <new description>`
}

function profileKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚙️ Max digest items", "edit_digest_max"), Markup.button.callback("📄 Format", "edit_digest_format")],
    [Markup.button.callback("🚫 Minus words", "edit_minus_words"), Markup.button.callback("📢 Рекомендация каналов", "recommend_channels")]
  ])
}

bot.action("profile", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  const user = getOrCreateUser(userId)
  await ctx.editMessageText(
    renderProfileText(userId, user),
    profileKeyboard()
  )
})

bot.action("edit_digest_max", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  const user = getOrCreateUser(userId)
  const current = user.digest_max_items ?? 7
  await ctx.editMessageText(
    `Max digest items: ${current}.\nChoose new limit:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("5", "set_max:5"),
        Markup.button.callback("7", "set_max:7"),
        Markup.button.callback("10", "set_max:10"),
        Markup.button.callback("15", "set_max:15")
      ],
      [Markup.button.callback("🔙 Back to profile", "profile")]
    ])
  )
})

bot.action(/^set_max:(\d+)$/, async (ctx) => {
  const val = parseInt(ctx.match[1], 10)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) {
    await safeAnswerCbQuery(ctx)
    return
  }
  updateUserDigestMax(userId, val)
  await safeAnswerCbQuery(ctx, `Saved: ${val}`)
  const user = getOrCreateUser(userId)
  await ctx.editMessageText(
    renderProfileText(userId, user),
    profileKeyboard()
  )
})

bot.action("edit_digest_format", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  const current = getDigestFormat(userId)
  await ctx.editMessageText(
    `Формат дайджеста: ${current === "compact" ? "компактный (суть + ссылка)" : "полный"}.\nВыбери:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("📄 Полный", "digest_format:full"),
        Markup.button.callback("📋 Компактный", "digest_format:compact")
      ],
      [Markup.button.callback("🔙 Back to profile", "profile")]
    ])
  )
})

bot.action("edit_minus_words", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  pendingMinusWords.set(userId, true)
  const current = getUserMinusKeywords(userId)
  const hint = current.length > 0 ? `\nCurrent: ${current.join(", ")}.` : ""
  await ctx.reply(
    `Send minus words separated by comma. Posts containing any of these will be excluded from your digest. Send "clear" or empty message to clear.${hint}`
  )
})

bot.action("recommend_channels", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  const user = getOrCreateUser(userId)
  const profile = (user.profile || "").trim()
  if (!profile) {
    await ctx.reply(
      "Укажите профиль (интересы, профессия, цели), чтобы получить рекомендации каналов. Отправьте текст в чат или через Profile."
    )
    return
  }
  const channels = getChannels()
  const usernames = channels.map((c) => c.username)
  if (usernames.length === 0) {
    await ctx.reply("Пока нет каналов в боте. Добавьте каналы через Channels → Add channel.")
    return
  }
  const loading = await ctx.reply("Подбираю каналы по вашему профилю…")
  try {
    const recommended = await recommendChannels(profile, usernames)
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => { })
    if (recommended.length === 0) {
      await ctx.reply("По вашему профилю не удалось подобрать рекомендации. Попробуйте расширить описание интересов.")
      return
    }
    const lines = recommended.map(
      (r) => `• @${r.username} — ${r.reason || "релевантно профилю"}`
    )
    const text = `📢 <b>Рекомендации по вашему профилю</b>\n\n${lines.join("\n\n")}\n\n<i>Нажмите «⭐ Важный», чтобы чаще видеть посты этого канала в дайджесте.</i>`
    const keyboard = {
      reply_markup: {
        inline_keyboard: recommended.map((r) => [
          { text: `⭐ Важный @${r.username}`, callback_data: `rec_pri:${r.username}` }
        ])
      }
    }
    await ctx.telegram.sendMessage(ctx.chat.id, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...keyboard
    })
  } catch (e) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loading.message_id,
      null,
      "Не удалось получить рекомендации. Попробуйте позже.\n\n" + formatErrorForChat(e)
    ).catch(() => { })
  }
})

bot.action(/^rec_pri:(.+)$/, async (ctx) => {
  const username = ctx.match[1].toLowerCase()
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) {
    await safeAnswerCbQuery(ctx)
    return
  }
  setUserChannelPriority(userId, username, 2)
  clearRankingsForUser(userId, todayDate())
  await safeAnswerCbQuery(ctx, "✓ Отмечен как важный")
})

bot.action("add_channels", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  pendingAddChannels.set(userId, true)
  await ctx.reply(
    "Send any message with @channel names (e.g. @ai_newz @cryptoessay). I'll add all of them and skip already added."
  )
})

bot.action("remove_channel", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const channels = getChannels()
  if (!channels.length) {
    await ctx.editMessageText("No channels yet. Add via Add channel or /add @channel.")
    return
  }
  const maxButtons = 20
  const rows = channels.slice(0, maxButtons).map((c) => [
    Markup.button.callback(`@${c.username}`, `remove_ch:${c.username}`)
  ])
  await ctx.editMessageText(
    "Send @channel to remove or tap one below:",
    Markup.inlineKeyboard(rows)
  )
})

bot.action(/^remove_ch:(.+)$/, async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const username = ctx.match[1].toLowerCase()
  const removed = removeChannel(username)
  await ctx.editMessageText(
    removed ? `Channel @${username} removed.` : `Channel @${username} not found.`
  )
})

function channelSettingsKeyboard(userId) {
  const channels = getChannels()
  const settings = getUserChannelSettings(userId)
  const maxCh = 20
  const rows = []
  for (const c of channels.slice(0, maxCh)) {
    const s = settings[c.username] || { hidden: false, priority: 1 }
    const hideLabel = s.hidden ? "👁 Show" : "👁 Hide"
    const priLabel = s.priority === 2 ? "⭐ Important" : "○ Normal"
    rows.push([
      Markup.button.callback(`${hideLabel} @${c.username}`, `ch_hide:${c.username}`),
      Markup.button.callback(priLabel, `ch_pri:${c.username}`)
    ])
  }
  rows.push([Markup.button.callback("← Back to channels", "channels")])
  return Markup.inlineKeyboard(rows)
}

bot.action("channel_settings", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  const channels = getChannels()
  if (channels.length === 0) {
    await ctx.editMessageText(
      "No channels yet. Add via Add channel or /add @channel, then you can hide channels from digest or mark them as important.",
      Markup.inlineKeyboard([[Markup.button.callback("← Back to channels", "channels")]])
    )
    return
  }
  await ctx.editMessageText(
    "Channel settings:\n• Hide — do not show this channel in digest (channel stays in list).\n• Important — prefer this channel when ranking.",
    channelSettingsKeyboard(userId)
  )
})

bot.action(/^ch_hide:(.+)$/, async (ctx) => {
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) { await safeAnswerCbQuery(ctx); return }
  const username = ctx.match[1].toLowerCase()
  toggleUserChannelHidden(userId, username)
  clearRankingsForUser(userId, todayDate())
  await safeAnswerCbQuery(ctx)
  await ctx.editMessageText(
    "Channel settings:\n• Hide — do not show this channel in digest (channel stays in list).\n• Important — prefer this channel when ranking.",
    channelSettingsKeyboard(userId)
  )
})

bot.action(/^ch_pri:(.+)$/, async (ctx) => {
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) { await safeAnswerCbQuery(ctx); return }
  const username = ctx.match[1].toLowerCase()
  cycleUserChannelPriority(userId, username)
  clearRankingsForUser(userId, todayDate())
  await safeAnswerCbQuery(ctx)
  await ctx.editMessageText(
    "Channel settings:\n• Hide — do not show this channel in digest (channel stays in list).\n• Important — prefer this channel when ranking.",
    channelSettingsKeyboard(userId)
  )
})

bot.action(/^summary_date:(.+)$/, async (ctx) => {
  const dateStr = ctx.match[1]
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId) return

  const user = getOrCreateUser(userId)
  const since = `${dateStr}T00:00:00.000Z`
  const until = new Date(new Date(since).getTime() + 24 * 60 * 60 * 1000).toISOString()
  const chatId = ctx.chat.id

  const channelUsernames = getChannelUsernames()
  if (channelUsernames.length === 0) {
    await ctx.telegram.sendMessage(
      chatId,
      "Add channels first (Channels → Add channel, or forward a post from a channel)."
    )
    return
  }

  const statusMsg = await ctx.telegram.sendMessage(
    chatId,
    "Checking all channels (including new ones)…"
  )
  let messageToEdit = statusMsg.message_id

  let collectResult
  try {
    collectResult = await collectChannelPosts({
      onProgress: async ({ channel, index, total, collected }) => {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          null,
          `Fetching: ${index}/${total} @${channel}… (${collected} posts)`
        ).catch(() => { })
      }
    })
  } catch (e) {
    console.error("Collect posts error:", e)
    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      "Failed to fetch posts. Try again later.\n\nError: " + formatErrorForChat(e)
    )
    return
  }

  await ctx.telegram.editMessageText(
    chatId,
    statusMsg.message_id,
    null,
    "Generating summary…"
  ).catch(() => { })

  const posts = getPostsForDateRange(since, until)

  if (posts.length === 0) {
    await ctx.telegram.editMessageText(
      chatId,
      messageToEdit,
      null,
      "No posts for the selected day. Only recent days are available (last 24h of collection)."
    )
    return
  }

  await ctx.telegram.sendMessage(chatId, formatCollectAnalytics(collectResult)).catch(() => { })

  const postsFiltered = posts.filter((p) => !isAdPost(p))
  if (postsFiltered.length === 0) {
    await ctx.telegram.editMessageText(
      chatId,
      messageToEdit,
      null,
      "No posts for the selected day (or only ad/promotional content, which is excluded)."
    )
    return
  }

  const label = formatDateLabel(dateStr)
  const maxItems = Math.min(20, Math.max(3, user.digest_max_items ?? 7))

  // Удаляем сообщение "Generating..." перед отправкой блоков
  try {
    await ctx.telegram.deleteMessage(chatId, messageToEdit).catch(() => { })
  } catch (_) { }

  await sendSummaryBlocks(ctx, dateStr, label, 0, { maxItems, chatId })
})

/** Подгрузка следующих блоков summary. */
bot.action(/^summary_more:(.+):(\d+):(\d+)$/, async (ctx) => {
  const dateStr = ctx.match[1]
  const offset = parseInt(ctx.match[2], 10)
  const maxItems = parseInt(ctx.match[3], 10)
  await safeAnswerCbQuery(ctx, "Загружаю…")
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return

  const label = formatDateLabel(dateStr)
  await sendSummaryBlocks(ctx, dateStr, label, offset, { maxItems })
})

bot.action("summary_weekly", async (ctx) => {
  await safeAnswerCbQuery(ctx)
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  const user = getOrCreateUser(userId)
  const chatId = ctx.chat.id

  const until = new Date()
  until.setDate(until.getDate() + 1)
  until.setUTCHours(0, 0, 0, 0)
  const since = new Date(until)
  since.setDate(since.getDate() - 7)
  const sinceStr = since.toISOString().slice(0, 10) + "T00:00:00.000Z"
  const untilStr = until.toISOString().slice(0, 10) + "T00:00:00.000Z"

  const statusMsg = await ctx.telegram.sendMessage(chatId, "Generating weekly digest…")
  const messageToEdit = statusMsg.message_id

  let posts = getPostsForDateRange(sinceStr, untilStr)
  posts = filterPostsForUser(posts, userId)
  posts = posts.filter((p) => !isAdPost(p))

  if (posts.length === 0) {
    await ctx.telegram.editMessageText(
      chatId,
      messageToEdit,
      null,
      "No posts for the last 7 days (or all filtered by your settings)."
    )
    return
  }

  const label = formatDateRangeLabel(since, until)
  const optsMd = { parse_mode: "Markdown", disable_web_page_preview: true }
  const optsHtml = { parse_mode: "HTML", disable_web_page_preview: true }
  const maxItems = Math.min(20, Math.max(3, user.digest_max_items ?? 7))
  try {
    const { teaser, blocks } = await generateSummaryBlocks(posts, label, user.profile || "", maxItems)
    const postById = buildPostById(posts)

    await ctx.telegram.deleteMessage(chatId, messageToEdit).catch(() => { })

    if (blocks.length === 0) {
      await ctx.telegram.sendMessage(chatId, `📋 Дайджест за ${label}\n\nНе удалось сформировать блоки. Попробуйте позже.`)
      return
    }

    const header = formatDigestHeader(label, teaser, blocks.length)
    await ctx.telegram.sendMessage(chatId, header, optsHtml)

    for (const block of blocks) {
      await ctx.telegram.sendMessage(chatId, formatBlockText(block, postById), optsHtml)
    }
  } catch (e) {
    console.error("Weekly summary error:", e)
    await ctx.telegram.editMessageText(
      chatId,
      messageToEdit,
      null,
      "Failed to generate weekly digest.\n\nError: " + formatErrorForChat(e)
    ).catch(() => { })
    await ctx.telegram.sendMessage(chatId, "Failed to generate weekly digest. Try again later.")
  }
})

bot.command("profile", (ctx) => {
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return

  const user = getOrCreateUser(userId)
  if (ctx.message.text.trim() === "/profile") {
    return ctx.reply(
      renderProfileText(userId, user),
      profileKeyboard()
    )
  }

  const profile = ctx.message.text.replace(/^\/profile\s*/i, "").trim()
  if (!profile) return ctx.reply("Write a description: interests, profession, goals.")
  updateUserProfile(userId, profile)
  return ctx.reply("Profile saved. It will be used for ranking.")
})

bot.command("digest_max", (ctx) => {
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return

  const match = ctx.message.text.match(/\s+(\d+)/)
  const value = match ? updateUserDigestMax(userId, match[1]) : null
  if (value != null) {
    return ctx.reply(`Max digest items set to ${value}. Summary will show up to ${value} items.`)
  }
  return ctx.reply("Usage: /digest_max 5 or 10 or 15 (max items in summary digest).")
})

bot.command("digest_format", (ctx) => {
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return
  const current = getDigestFormat(userId)
  return ctx.reply(
    `Формат дайджеста: ${current === "compact" ? "компактный (суть + ссылка)" : "полный"}.\nВыбери:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("📄 Полный", "digest_format:full"),
        Markup.button.callback("📋 Компактный", "digest_format:compact")
      ]
    ])
  )
})

bot.action(/^digest_format:(full|compact)$/, async (ctx) => {
  const format = ctx.match[1]
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) {
    await safeAnswerCbQuery(ctx)
    return
  }
  setDigestFormat(userId, format)
  await safeAnswerCbQuery(ctx, "Format saved")
  const user = getOrCreateUser(userId)
  await ctx.editMessageText(
    renderProfileText(userId, user),
    profileKeyboard()
  ).catch(() => { })
})

bot.command("minus_words", (ctx) => {
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return

  const rest = ctx.message.text.replace(/^\/minus_words\s*/i, "").trim()
  updateUserMinusKeywords(userId, rest || null)
  clearRankingsForUser(userId, todayDate())
  const words = getUserMinusKeywords(userId)
  if (words.length === 0) {
    return ctx.reply("Minus words cleared. Posts are no longer filtered by keywords.")
  }
  return ctx.reply(
    `Minus words set. Posts containing any of these will be excluded from your digest:\n${words.join(", ")}`
  )
})

bot.command("summary", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return
  return ctx.reply("Choose date for summary:", summaryDateKeyboard())
})

bot.command("channels", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return
  const channels = getChannels()
  return ctx.reply(formatChannelList(channels), channelsKeyboard())
})

bot.command("menu", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return
  return ctx.reply("Choose an action:", mainMenuKeyboard())
})

bot.command("add", (ctx) => {
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return

  const match = ctx.message.text.match(/\s*@?(\w+)/)
  const username = match ? match[1].toLowerCase() : null
  if (!username) return ctx.reply("Usage: /add @channel or /add channel")

  const result = addChannel(username, userId)
  if (result.ok) return ctx.reply(`Channel @${result.username} added.`)
  if (result.exists) return ctx.reply(`@${result.username} is already tracked.`)
  return ctx.reply("Failed to add channel.")
})

bot.command("remove", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return

  const match = ctx.message.text.match(/\s*@?(\w+)/)
  const username = match ? match[1].toLowerCase() : null
  if (!username) return ctx.reply("Usage: /remove @channel or /remove channel")

  const removed = removeChannel(username)
  return ctx.reply(removed ? `Channel @${username} removed.` : `Channel @${username} not found.`)
})

function parseChannelUsernames(text) {
  if (!text || typeof text !== "string") return []
  const matches = text.match(/@([a-zA-Z0-9_]+)/g) || []
  const seen = new Set()
  return matches
    .map((m) => m.slice(1).toLowerCase())
    .filter((u) => u.length >= 5 && u.length <= 32 && !seen.has(u) && seen.add(u))
}

bot.on("message", async (ctx, next) => {
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return next()

  const text = ctx.message.text?.trim()
  if (!text) return next()
  if (pendingAddChannels.get(userId)) return next()
  if (pendingMinusWords.get(userId)) return next()

  if (text === MENU_BTN_DIGEST) {
    const user = getOrCreateUser(userId)
    const date = todayDate()
    const hasRankings = getRankedPostIds(userId, date, 1).length > 0
    if (!hasRankings) {
      const loading = await ctx.reply("Ranking posts for your profile…")
      try {
        await ensureRankingsForUser(userId, user.profile || "")
      } catch (e) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loading.message_id,
          null,
          "Failed to get ranking (Gemini error). Try again later.\n\nError: " + formatErrorForChat(e)
        )
        return
      }
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id)
    }
    return digestReply(ctx, 0)
  }

  if (text === MENU_BTN_SUMMARY) {
    return ctx.reply("Choose date for summary:", summaryDateKeyboard())
  }

  if (text === MENU_BTN_CHANNELS) {
    const channels = getChannels()
    return ctx.reply(formatChannelList(channels), channelsKeyboard())
  }

  if (text === MENU_BTN_PROFILE) {
    const user = getOrCreateUser(userId)
    return ctx.reply(
      renderProfileText(userId, user),
      profileKeyboard()
    )
  }

  if (text === MENU_BTN_MENU) {
    return ctx.reply("Choose an action:", mainMenuKeyboard())
  }

  return next()
})

bot.on("message", async (ctx, next) => {
  const userId = ctx.from?.id
  if (!userId || isUserBanned(userId)) return next()

  const text = ctx.message.text
  if (pendingMinusWords.get(userId)) {
    pendingMinusWords.delete(userId)
    const raw = (text && text.trim()) || ""
    const isClear = raw === "" || raw.toLowerCase() === "clear"
    updateUserMinusKeywords(userId, isClear ? null : raw)
    clearRankingsForUser(userId, todayDate())
    const words = getUserMinusKeywords(userId)
    if (words.length === 0) {
      return ctx.reply("Minus words cleared. Posts are no longer filtered by keywords.")
    }
    return ctx.reply(`Minus words set (${words.length}): ${words.join(", ")}`)
  }
  if (pendingAddChannels.get(userId)) {
    pendingAddChannels.delete(userId)
    if (!text || !text.trim()) {
      return ctx.reply("No text received. Send a message with @channel names (e.g. @ai_newz @cryptoessay).")
    }
    const usernames = parseChannelUsernames(text)
    if (usernames.length === 0) {
      return ctx.reply("No channel usernames found. Use @username format (e.g. @ai_newz).")
    }
    const added = []
    const already = []
    for (const username of usernames) {
      const result = addChannel(username, userId)
      if (result.ok) added.push(result.username)
      if (result.exists) already.push(result.username)
    }
    const parts = []
    if (added.length) parts.push(`Added: ${added.map((u) => `@${u}`).join(", ")}`)
    if (already.length) parts.push(`Already tracked: ${already.map((u) => `@${u}`).join(", ")}`)
    return ctx.reply(parts.length ? parts.join(". ") : "No channels added.")
  }

  const fwd = ctx.message?.forward_origin
  if (fwd?.type === "channel") {
    const channelUsername = fwd.chat?.username || fwd.sender_user_name
    if (channelUsername) {
      const normalized = String(channelUsername).replace(/^@/, "").toLowerCase()
      const result = addChannel(normalized, userId)
      if (result.ok) return ctx.reply(`Channel @${result.username} added.`)
      if (result.exists) return ctx.reply(`@${result.username} is already tracked.`)
      return ctx.reply("Failed to add channel (maybe private).")
    }
  }
  return next()
})


// Admin
bot.command("ban", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return

  const match = ctx.message.text.replace(/^\/ban\s*/i, "").trim()
  if (!match) return ctx.reply("Usage: /ban @username or /ban user_id")

  const result = banUserByUsernameOrId(match)
  if (result.ok) return ctx.reply(`User ${result.user_id} banned.`)
  return ctx.reply("User not found.")
})

bot.command("unban", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return

  const match = ctx.message.text.replace(/^\/unban\s*/i, "").trim()
  if (!match) return ctx.reply("Usage: /unban @username or /unban user_id")

  const result = unbanUserByUsernameOrId(match)
  if (!result.ok) return ctx.reply("User not found.")
  return ctx.reply(`User ${result.user_id} unbanned.`)
})

bot.command("close", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return
  setBotOpen(false)
  return ctx.reply("Bot is closed to new users.")
})

bot.command("open", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return
  setBotOpen(true)
  return ctx.reply("Bot is open again.")
})

bot.command("stats", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return
  const s = getStats()
  return ctx.reply(`Users: ${s.users}\nChannels: ${s.channels}\nPosts in DB: ${s.posts}`)
})

bot.catch((err, ctx) => {
  console.error("[bot] Unhandled error:", err.message || err)
  const msg = err.response?.description || err.message || "Произошла ошибка."
  const short = msg.length > 200 ? msg.slice(0, 197) + "…" : msg
  if (ctx?.chat?.id) {
    ctx.telegram.sendMessage(ctx.chat.id, "Ошибка: " + short).catch(() => { })
  }
})

export default bot
