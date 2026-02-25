import { Telegraf, Markup } from "telegraf";
import {
  getOrCreateUser,
  getUser,
  isUserBanned,
  isBotOpen,
  setBotOpen,
  getChannels,
  addChannel,
  removeChannel,
  getPostsLast24h,
  getPostsByIds,
  getRankedPostIds,
  getRankingsMap,
  clearRankingsForUser,
  insertRankings,
  updateUserProfile,
  banUserByUsernameOrId,
  unbanUserByUsernameOrId,
  getStats,
  getPostsForDateRange
} from "./db.js";
import { rankPosts, generateSummary } from "./gemini.js";
import {
  formatDigestPage,
  formatChannelList,
  getLastDays,
  formatDateLabel,
  DIGEST_PAGE_SIZE
} from "./utils.js";
import { v4 as uuidv4 } from "uuid";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");

const bot = new Telegraf(BOT_TOKEN);

function todayDate() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function isAdmin(userId) {
  return Number.isInteger(ADMIN_ID) && userId === ADMIN_ID;
}

async function ensureRankingsForUser(userId, userProfile) {
  const date = todayDate();
  const existing = getRankedPostIds(userId, date, 1);
  if (existing.length > 0) return;

  const posts = getPostsLast24h();
  if (posts.length === 0) return;

  try {
    const ranked = await rankPosts(posts, userProfile);
    clearRankingsForUser(userId, date);
    const items = ranked.map((r) => ({
      id: uuidv4(),
      post_id: r.post_id,
      score: r.score,
      reason: r.reason
    }));
    insertRankings(userId, date, items);
  } catch (e) {
    console.error("Gemini rank error:", e);
    throw e;
  }
}

function digestReply(ctx, offset = 0) {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("Ошибка: неизвестный пользователь.");

  const date = todayDate();
  const postIds = getRankedPostIds(userId, date, DIGEST_PAGE_SIZE, offset);
  if (postIds.length === 0) {
    return ctx.reply(
      "Нет постов за сегодня или рейтинг ещё не готов. Попробуйте позже или добавьте каналы через /add или пересылку."
    );
  }

  const posts = getPostsByIds(postIds);
  const orderMap = {};
  postIds.forEach((id, i) => (orderMap[id] = i));
  posts.sort((a, b) => orderMap[a.id] - orderMap[b.id]);

  const reasonsMap = {};
  const rankMap = getRankingsMap(userId, date);
  for (const p of posts) rankMap[p.id] && (reasonsMap[p.id] = rankMap[p.id].reason);

  const text = formatDigestPage(posts, reasonsMap, offset);
  const totalRanked = getRankedPostIds(userId, date, 10000, 0).length;
  const hasMore = offset + DIGEST_PAGE_SIZE < totalRanked;

  const buttons = [];
  if (hasMore) buttons.push(Markup.button.callback("Ещё 10", `more:${offset + DIGEST_PAGE_SIZE}`));
  buttons.push(Markup.button.callback("Саммари", "summary"));

  return ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
}

bot.use((ctx, next) => {
  const userId = ctx.from?.id;
  if (userId) {
    const username = ctx.from?.username ? String(ctx.from.username).toLowerCase() : null;
    if (isBotOpen()) getOrCreateUser(userId, username);
    else if (getUser(userId)) getOrCreateUser(userId, username);
  }
  return next();
});

bot.start(async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.reply("Ошибка.");

  if (!isBotOpen()) {
    const existing = getUser(userId);
    if (!existing) {
      return ctx.reply("🔒 Бот сейчас закрыт для новых пользователей.");
    }
  }

  getOrCreateUser(userId, ctx.from?.username ? String(ctx.from.username).toLowerCase() : null);
  if (isUserBanned(userId)) {
    return ctx.reply("Вы заблокированы.");
  }

  await ctx.reply(
    "Привет! Я собираю посты из ваших каналов и делаю дайджест.\n\n" +
      "Команды:\n" +
      "/digest — топ постов за сегодня\n" +
      "/profile — указать интересы для персонализации\n" +
      "/summary — дайджест за выбранный день\n" +
      "/channels — список каналов\n" +
      "/add @channel — добавить канал\n" +
      "/remove @channel — удалить канал\n\n" +
      "Можно переслать пост из канала — канал добавится автоматически."
  );
});

bot.command("digest", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return;

  const user = getOrCreateUser(userId);
  const date = todayDate();
  const hasRankings = getRankedPostIds(userId, date, 1).length > 0;
  if (!hasRankings) {
    const loading = await ctx.reply("Ранжирую посты под ваш профиль…");
    try {
      await ensureRankingsForUser(userId, user.profile || "");
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        "Не удалось получить рейтинг (ошибка Gemini). Попробуйте позже."
      );
      return;
    }
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
  }
  return digestReply(ctx, 0);
});

bot.action(/^more:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const offset = parseInt(ctx.match[1], 10);
  const userId = ctx.from?.id;
  if (!userId) return;

  const date = todayDate();
  const postIds = getRankedPostIds(userId, date, DIGEST_PAGE_SIZE, offset);
  if (postIds.length === 0) {
    return ctx.answerCbQuery("Больше нет.");
  }

  const posts = getPostsByIds(postIds);
  const orderMap = {};
  postIds.forEach((id, i) => (orderMap[id] = i));
  posts.sort((a, b) => orderMap[a.id] - orderMap[b.id]);
  const rankMap = getRankingsMap(userId, date);
  const reasonsMap = {};
  for (const p of posts) rankMap[p.id] && (reasonsMap[p.id] = rankMap[p.id].reason);

  const text = formatDigestPage(posts, reasonsMap, offset);
  const totalRanked = getRankedPostIds(userId, date, 10000, 0).length;
  const hasMore = offset + DIGEST_PAGE_SIZE < totalRanked;

  const buttons = [];
  if (hasMore) buttons.push(Markup.button.callback("Ещё 10", `more:${offset + DIGEST_PAGE_SIZE}`));
  buttons.push(Markup.button.callback("Саммари", "summary"));

  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action("summary", async (ctx) => {
  await ctx.answerCbQuery();
  const days = getLastDays(7);
  const buttons = days.map((d) => Markup.button.callback(d.label, `summary_date:${d.date}`));
  await ctx.editMessageText("Выберите дату для саммари:", Markup.inlineKeyboard(buttons));
});

bot.action(/^summary_date:(.+)$/, async (ctx) => {
  const dateStr = ctx.match[1];
  await ctx.answerCbQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = getOrCreateUser(userId);
  const since = `${dateStr}T00:00:00.000Z`;
  const until = new Date(new Date(since).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const posts = getPostsForDateRange(since, until);

  const label = formatDateLabel(dateStr);
  const loading = await ctx.telegram.sendMessage(ctx.chat.id, "Генерирую саммари…");

  try {
    const summaryText = await generateSummary(posts, label, user.profile || "");
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, summaryText, {
      parse_mode: "Markdown",
      disable_web_page_preview: true
    });
  } catch (e) {
    console.error("Summary error:", e);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loading.message_id,
      null,
      "Не удалось сгенерировать саммари. Попробуйте позже."
    );
  }
});

bot.command("profile", (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return;

  const user = getOrCreateUser(userId);
  if (ctx.message.text.trim() === "/profile") {
    const profileText = user.profile || "не задан";
    return ctx.reply(`Ваш профиль (интересы, профессия):\n${profileText}\n\nОтправьте текстом новый профиль, чтобы обновить.`);
  }

  const profile = ctx.message.text.replace(/^\/profile\s*/i, "").trim();
  if (!profile) return ctx.reply("Напишите описание: интересы, профессия, цели.");
  updateUserProfile(userId, profile);
  return ctx.reply("Профиль сохранён. Он будет учитываться при ранжировании.");
});

bot.command("summary", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return;
  const days = getLastDays(7);
  const buttons = days.map((d) => Markup.button.callback(d.label, `summary_date:${d.date}`));
  return ctx.reply("Выберите дату для саммари:", Markup.inlineKeyboard(buttons));
});

bot.command("channels", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return;
  const channels = getChannels();
  return ctx.reply(formatChannelList(channels));
});

bot.command("add", (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return;

  const match = ctx.message.text.match(/\s*@?(\w+)/);
  const username = match ? match[1].toLowerCase() : null;
  if (!username) return ctx.reply("Использование: /add @channel или /add channel");

  const result = addChannel(username, userId);
  if (result.ok) return ctx.reply(`✅ Канал @${result.username} добавлен`);
  if (result.exists) return ctx.reply(`⚠️ Канал @${result.username} уже отслеживается`);
  return ctx.reply("Не удалось добавить канал.");
});

bot.command("remove", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return;

  const match = ctx.message.text.match(/\s*@?(\w+)/);
  const username = match ? match[1].toLowerCase() : null;
  if (!username) return ctx.reply("Использование: /remove @channel или /remove channel");

  const removed = removeChannel(username);
  return ctx.reply(removed ? `Канал @${username} удалён.` : `Канал @${username} не найден.`);
});

bot.on("message", async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return next();

  const fwd = ctx.message?.forward_origin;
  if (fwd?.type === "channel") {
    const channelUsername = fwd.chat?.username || fwd.sender_user_name;
    if (channelUsername) {
      const normalized = String(channelUsername).replace(/^@/, "").toLowerCase();
      const result = addChannel(normalized, userId);
      if (result.ok) return ctx.reply(`✅ Канал @${result.username} добавлен`);
      if (result.exists) return ctx.reply(`⚠️ Канал @${result.username} уже отслеживается`);
      return ctx.reply("Не удалось добавить канал (возможно, приватный).");
    }
  }
  return next();
});


// Admin
bot.command("ban", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return;

  const match = ctx.message.text.replace(/^\/ban\s*/i, "").trim();
  if (!match) return ctx.reply("Использование: /ban @username или /ban user_id");

  const result = banUserByUsernameOrId(match);
  if (result.ok) return ctx.reply(`Пользователь ${result.user_id} заблокирован.`);
  return ctx.reply("Пользователь не найден.");
});

bot.command("unban", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return;

  const match = ctx.message.text.replace(/^\/unban\s*/i, "").trim();
  if (!match) return ctx.reply("Использование: /unban @username или /unban user_id");

  const result = unbanUserByUsernameOrId(match);
  if (!result.ok) return ctx.reply("Пользователь не найден.");
  return ctx.reply(`Пользователь ${result.user_id} разблокирован.`);
});

bot.command("close", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return;
  setBotOpen(false);
  return ctx.reply("Бот закрыт для новых пользователей.");
});

bot.command("open", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return;
  setBotOpen(true);
  return ctx.reply("Бот снова открыт.");
});

bot.command("stats", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return;
  const s = getStats();
  return ctx.reply(`Пользователей: ${s.users}\nКаналов: ${s.channels}\nПостов в БД: ${s.posts}`);
});

export default bot;
