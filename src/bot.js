import { Telegraf, Markup } from "telegraf";
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
  banUserByUsernameOrId,
  unbanUserByUsernameOrId,
  getStats,
  getPostsForDateRange
} from "./db.js";
import { collectChannelPosts } from "./gramjs.js";
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

const pendingAddChannels = new Map();

const MENU_BTN_DIGEST = "📰 Digest";
const MENU_BTN_SUMMARY = "📋 Summary";
const MENU_BTN_CHANNELS = "📢 Channels";
const MENU_BTN_PROFILE = "👤 Profile";
const MENU_BTN_MENU = "📱 Menu";

function mainReplyKeyboard() {
  return Markup.keyboard([
    [MENU_BTN_DIGEST, MENU_BTN_SUMMARY],
    [MENU_BTN_CHANNELS, MENU_BTN_PROFILE],
    [MENU_BTN_MENU]
  ]).resize();
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
  ]);
}

function channelsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add channel", "add_channels"), Markup.button.callback("➖ Remove channel", "remove_channel")]
  ]);
}

function todayDate() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function isAdmin(userId) {
  return Number.isInteger(ADMIN_ID) && userId === ADMIN_ID;
}

function formatErrorForChat(e) {
  const raw = (e && (e.message || e.reason)) || String(e);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 250 ? oneLine.slice(0, 247) + "…" : oneLine;
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
  if (!userId) return ctx.reply("Error: unknown user.");

  const date = todayDate();
  const postIds = getRankedPostIds(userId, date, DIGEST_PAGE_SIZE, offset);
  if (postIds.length === 0) {
    return ctx.reply(
      "No posts for today or ranking not ready yet. Try later or add channels via /add or by forwarding a post."
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
  if (hasMore) buttons.push(Markup.button.callback("▶️ More 10", `more:${offset + DIGEST_PAGE_SIZE}`));
  buttons.push(Markup.button.callback("📋 Summary", "summary"));

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
  if (!userId) return ctx.reply("Error.");

  if (!isBotOpen()) {
    const existing = getUser(userId);
    if (!existing) {
      return ctx.reply("Bot is closed to new users.");
    }
  }

  getOrCreateUser(userId, ctx.from?.username ? String(ctx.from.username).toLowerCase() : null);
  if (isUserBanned(userId)) {
    return ctx.reply("You are blocked.");
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
  );
  await ctx.reply("Choose an action:", mainMenuKeyboard());
});

bot.command("digest", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return;

  const user = getOrCreateUser(userId);
  const date = todayDate();
  const hasRankings = getRankedPostIds(userId, date, 1).length > 0;
  if (!hasRankings) {
    const loading = await ctx.reply("Ranking posts for your profile…");
    try {
      await ensureRankingsForUser(userId, user.profile || "");
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        "Failed to get ranking (Gemini error). Try again later.\n\nError: " + formatErrorForChat(e)
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
    return ctx.answerCbQuery("No more.");
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
  if (hasMore) buttons.push(Markup.button.callback("▶️ More 10", `more:${offset + DIGEST_PAGE_SIZE}`));
  buttons.push(Markup.button.callback("📋 Summary", "summary"));

  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action("digest", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return;
  const user = getOrCreateUser(userId);
  const date = todayDate();
  const hasRankings = getRankedPostIds(userId, date, 1).length > 0;
  if (!hasRankings) {
    const loading = await ctx.telegram.sendMessage(ctx.chat.id, "Ranking posts for your profile…");
    try {
      await ensureRankingsForUser(userId, user.profile || "");
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        "Failed to get ranking (Gemini error). Try again later.\n\nError: " + formatErrorForChat(e)
      );
      return;
    }
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
  }
  await digestReply(ctx, 0);
});

bot.action("summary", async (ctx) => {
  await ctx.answerCbQuery();
  const days = getLastDays(7);
  const buttons = days.map((d) => Markup.button.callback(d.label, `summary_date:${d.date}`));
  await ctx.editMessageText("Choose date for summary:", Markup.inlineKeyboard(buttons));
});

bot.action("channels", async (ctx) => {
  await ctx.answerCbQuery();
  const channels = getChannels();
  await ctx.editMessageText(formatChannelList(channels), channelsKeyboard());
});

bot.action("profile", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return;
  const user = getOrCreateUser(userId);
  const profileText = user.profile || "not set";
  await ctx.editMessageText(
    `Your profile (interests, profession):\n${profileText}\n\nSend a new profile as text to update.`
  );
});

bot.action("add_channels", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return;
  pendingAddChannels.set(userId, true);
  await ctx.reply(
    "Send any message with @channel names (e.g. @ai_newz @cryptoessay). I'll add all of them and skip already added."
  );
});

bot.action("remove_channel", async (ctx) => {
  await ctx.answerCbQuery();
  const channels = getChannels();
  if (!channels.length) {
    await ctx.editMessageText("No channels yet. Add via Add channel or /add @channel.");
    return;
  }
  const maxButtons = 20;
  const rows = channels.slice(0, maxButtons).map((c) => [
    Markup.button.callback(`@${c.username}`, `remove_ch:${c.username}`)
  ]);
  await ctx.editMessageText(
    "Send @channel to remove or tap one below:",
    Markup.inlineKeyboard(rows)
  );
});

bot.action(/^remove_ch:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const username = ctx.match[1].toLowerCase();
  const removed = removeChannel(username);
  await ctx.editMessageText(
    removed ? `Channel @${username} removed.` : `Channel @${username} not found.`
  );
});

bot.action(/^summary_date:(.+)$/, async (ctx) => {
  const dateStr = ctx.match[1];
  await ctx.answerCbQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  const user = getOrCreateUser(userId);
  const since = `${dateStr}T00:00:00.000Z`;
  const until = new Date(new Date(since).getTime() + 24 * 60 * 60 * 1000).toISOString();
  let posts = getPostsForDateRange(since, until);
  const chatId = ctx.chat.id;
  let messageToEdit = null;

  if (posts.length === 0) {
    const channelUsernames = getChannelUsernames();
    if (channelUsernames.length === 0) {
      await ctx.telegram.sendMessage(
        chatId,
        "Add channels first (Channels → Add channel, or forward a post from a channel)."
      );
      return;
    }

    const statusMsg = await ctx.telegram.sendMessage(
      chatId,
      "No posts for this day yet. Fetching from all channels — this may take a minute…"
    );
    messageToEdit = statusMsg.message_id;

    try {
      await collectChannelPosts({
        onProgress: async ({ channel, index, total, collected }) => {
          await ctx.telegram.editMessageText(
            chatId,
            statusMsg.message_id,
            null,
            `Fetching channels: ${index}/${total} @${channel}… (posts collected: ${collected})`
          ).catch(() => {});
        }
      });
    } catch (e) {
      console.error("Collect posts error:", e);
      await ctx.telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        null,
        "Failed to fetch posts. Try again later.\n\nError: " + formatErrorForChat(e)
      );
      return;
    }

    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      "Checking posts for the selected day…"
    ).catch(() => {});

    posts = getPostsForDateRange(since, until);

    if (posts.length === 0) {
      await ctx.telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        null,
        "No posts for the selected day. Only recent days are available."
      );
      return;
    }

    await ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      "Done. Generating summary…"
    ).catch(() => {});
  } else {
    const loading = await ctx.telegram.sendMessage(chatId, "Generating summary…");
    messageToEdit = loading.message_id;
  }

  const label = formatDateLabel(dateStr);
  const opts = { parse_mode: "Markdown", disable_web_page_preview: true };
  try {
    let summaryText = await generateSummary(posts, label, user.profile || "");
    const maxLen = 4096;
    if (summaryText.length > maxLen) summaryText = summaryText.slice(0, maxLen - 1) + "…";

    try {
      await ctx.telegram.editMessageText(chatId, messageToEdit, null, summaryText, opts);
    } catch (editErr) {
      console.error("Summary editMessageText failed:", editErr.message || editErr);
      await ctx.telegram.sendMessage(chatId, summaryText, opts);
      await ctx.telegram.sendMessage(
        chatId,
        "Summary sent above. (Could not update the previous message: " + formatErrorForChat(editErr) + ")"
      ).catch(() => {});
    }
  } catch (e) {
    console.error("Summary error:", e);
    const errMsg = "Failed to generate summary. Try again later.\n\nError: " + formatErrorForChat(e);
    try {
      await ctx.telegram.editMessageText(chatId, messageToEdit, null, errMsg);
    } catch (_) {
      await ctx.telegram.sendMessage(chatId, errMsg);
    }
  }
});

bot.command("profile", (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return;

  const user = getOrCreateUser(userId);
  if (ctx.message.text.trim() === "/profile") {
    const profileText = user.profile || "not set";
    return ctx.reply(`Your profile (interests, profession):\n${profileText}\n\nSend a new profile as text to update.`);
  }

  const profile = ctx.message.text.replace(/^\/profile\s*/i, "").trim();
  if (!profile) return ctx.reply("Write a description: interests, profession, goals.");
  updateUserProfile(userId, profile);
  return ctx.reply("Profile saved. It will be used for ranking.");
});

bot.command("summary", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return;
  const days = getLastDays(7);
  const buttons = days.map((d) => Markup.button.callback(d.label, `summary_date:${d.date}`));
  return ctx.reply("Choose date for summary:", Markup.inlineKeyboard(buttons));
});

bot.command("channels", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return;
  const channels = getChannels();
  return ctx.reply(formatChannelList(channels), channelsKeyboard());
});

bot.command("menu", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return;
  return ctx.reply("Choose an action:", mainMenuKeyboard());
});

bot.command("add", (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return;

  const match = ctx.message.text.match(/\s*@?(\w+)/);
  const username = match ? match[1].toLowerCase() : null;
  if (!username) return ctx.reply("Usage: /add @channel or /add channel");

  const result = addChannel(username, userId);
  if (result.ok) return ctx.reply(`Channel @${result.username} added.`);
  if (result.exists) return ctx.reply(`@${result.username} is already tracked.`);
  return ctx.reply("Failed to add channel.");
});

bot.command("remove", (ctx) => {
  if (!ctx.from?.id || isUserBanned(ctx.from.id)) return;

  const match = ctx.message.text.match(/\s*@?(\w+)/);
  const username = match ? match[1].toLowerCase() : null;
  if (!username) return ctx.reply("Usage: /remove @channel or /remove channel");

  const removed = removeChannel(username);
  return ctx.reply(removed ? `Channel @${username} removed.` : `Channel @${username} not found.`);
});

function parseChannelUsernames(text) {
  if (!text || typeof text !== "string") return [];
  const matches = text.match(/@([a-zA-Z0-9_]+)/g) || [];
  const seen = new Set();
  return matches
    .map((m) => m.slice(1).toLowerCase())
    .filter((u) => u.length >= 5 && u.length <= 32 && !seen.has(u) && seen.add(u));
}

bot.on("message", async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return next();

  const text = ctx.message.text?.trim();
  if (!text) return next();
  if (pendingAddChannels.get(userId)) return next();

  if (text === MENU_BTN_DIGEST) {
    const user = getOrCreateUser(userId);
    const date = todayDate();
    const hasRankings = getRankedPostIds(userId, date, 1).length > 0;
    if (!hasRankings) {
      const loading = await ctx.reply("Ranking posts for your profile…");
      try {
        await ensureRankingsForUser(userId, user.profile || "");
      } catch (e) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loading.message_id,
          null,
          "Failed to get ranking (Gemini error). Try again later.\n\nError: " + formatErrorForChat(e)
        );
        return;
      }
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
    }
    return digestReply(ctx, 0);
  }

  if (text === MENU_BTN_SUMMARY) {
    const days = getLastDays(7);
    const buttons = days.map((d) => Markup.button.callback(d.label, `summary_date:${d.date}`));
    return ctx.reply("Choose date for summary:", Markup.inlineKeyboard(buttons));
  }

  if (text === MENU_BTN_CHANNELS) {
    const channels = getChannels();
    return ctx.reply(formatChannelList(channels), channelsKeyboard());
  }

  if (text === MENU_BTN_PROFILE) {
    const user = getOrCreateUser(userId);
    const profileText = user.profile || "not set";
    return ctx.reply(
      `Your profile (interests, profession):\n${profileText}\n\nSend a new profile as text to update.`
    );
  }

  if (text === MENU_BTN_MENU) {
    return ctx.reply("Choose an action:", mainMenuKeyboard());
  }

  return next();
});

bot.on("message", async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || isUserBanned(userId)) return next();

  const text = ctx.message.text;
  if (pendingAddChannels.get(userId)) {
    pendingAddChannels.delete(userId);
    if (!text || !text.trim()) {
      return ctx.reply("No text received. Send a message with @channel names (e.g. @ai_newz @cryptoessay).");
    }
    const usernames = parseChannelUsernames(text);
    if (usernames.length === 0) {
      return ctx.reply("No channel usernames found. Use @username format (e.g. @ai_newz).");
    }
    const added = [];
    const already = [];
    for (const username of usernames) {
      const result = addChannel(username, userId);
      if (result.ok) added.push(result.username);
      if (result.exists) already.push(result.username);
    }
    const parts = [];
    if (added.length) parts.push(`Added: ${added.map((u) => `@${u}`).join(", ")}`);
    if (already.length) parts.push(`Already tracked: ${already.map((u) => `@${u}`).join(", ")}`);
    return ctx.reply(parts.length ? parts.join(". ") : "No channels added.");
  }

  const fwd = ctx.message?.forward_origin;
  if (fwd?.type === "channel") {
    const channelUsername = fwd.chat?.username || fwd.sender_user_name;
    if (channelUsername) {
      const normalized = String(channelUsername).replace(/^@/, "").toLowerCase();
      const result = addChannel(normalized, userId);
      if (result.ok) return ctx.reply(`Channel @${result.username} added.`);
      if (result.exists) return ctx.reply(`@${result.username} is already tracked.`);
      return ctx.reply("Failed to add channel (maybe private).");
    }
  }
  return next();
});


// Admin
bot.command("ban", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return;

  const match = ctx.message.text.replace(/^\/ban\s*/i, "").trim();
  if (!match) return ctx.reply("Usage: /ban @username or /ban user_id");

  const result = banUserByUsernameOrId(match);
  if (result.ok) return ctx.reply(`User ${result.user_id} banned.`);
  return ctx.reply("User not found.");
});

bot.command("unban", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return;

  const match = ctx.message.text.replace(/^\/unban\s*/i, "").trim();
  if (!match) return ctx.reply("Usage: /unban @username or /unban user_id");

  const result = unbanUserByUsernameOrId(match);
  if (!result.ok) return ctx.reply("User not found.");
  return ctx.reply(`User ${result.user_id} unbanned.`);
});

bot.command("close", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return;
  setBotOpen(false);
  return ctx.reply("Bot is closed to new users.");
});

bot.command("open", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return;
  setBotOpen(true);
  return ctx.reply("Bot is open again.");
});

bot.command("stats", (ctx) => {
  if (!ctx.from?.id || !isAdmin(ctx.from.id)) return;
  const s = getStats();
  return ctx.reply(`Users: ${s.users}\nChannels: ${s.channels}\nPosts in DB: ${s.posts}`);
});

export default bot;
