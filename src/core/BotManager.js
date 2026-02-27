import { Telegraf } from "telegraf"
import { BotService } from "../services/BotService.js"
import { BotCache } from "../services/BotCache.js"
import { CommandHandler } from "../handlers/CommandHandler.js"
import { ActionHandler } from "../handlers/ActionHandler.js"
import { AdminHandler } from "../handlers/AdminHandler.js"
import {
	isBotOpen,
	getOrCreateUser,
	getUser,
	isUserBanned,
	addChannel,
} from "../db.js"
import ai, { autoInit } from "../ai/index.js"
import {
	BTN_DIGEST,
	BTN_SUMMARY,
	BTN_CHANNELS,
	BTN_PROFILE,
	BTN_ANALYZE_CHANNEL,
	BTN_CHANNEL_AUDIT,
	BTN_SETTINGS,
	BTN_MINUS_WORDS,
	BTN_DIGEST_MAX_ITEMS,
	BTN_DIGEST_FORMAT,
	BTN_EDIT_PROFILE,
	BTN_ADD_CHANNEL,
	BTN_REMOVE_CHANNEL,
	BTN_BACK,
	BTN_FETCH
} from "../ui/ButtonLabels.js"

export class BotManager {
	constructor(token) {
		this.bot = new Telegraf(token)
		this.cache = new BotCache()
		this.ai = ai
		this.service = new BotService(this)

		this.handlers = {
			command: new CommandHandler(this),
			action: new ActionHandler(this),
			admin: new AdminHandler(this)
		}
	}

	init() {
		this._registerMiddleware()
		this._registerCommands()
		this._registerActions()
		this._registerHandlers()

		// Инициализация AI роутера
		autoInit().catch(e => console.warn("[BotManager] AI init failed:", e.message))

		this.bot.catch((err, ctx) => {
			console.error("[BotManager] Unhandled error:", err)
			ctx.reply("Произошла ошибка. Попробуйте позже.").catch(() => { })
		})
	}

	_registerMiddleware() {
		this.bot.use((ctx, next) => {
			const userId = ctx.from?.id
			if (userId) {
				const username = ctx.from?.username ? String(ctx.from.username).toLowerCase() : null
				if (isBotOpen()) getOrCreateUser(userId, username)
				else if (getUser(userId)) getOrCreateUser(userId, username)
			}
			return next()
		})
	}

	_registerCommands() {
		const { command: cmd, admin } = this.handlers

		this.bot.start((ctx) => cmd.handleStart(ctx))
		this.bot.command("digest", (ctx) => cmd.handleDigest(ctx))
		this.bot.command("analyze_channel", (ctx) => cmd.handleAnalyzeChannel(ctx))
		this.bot.command("channel_audit", (ctx) => cmd.handleChannelAudit(ctx))
		this.bot.command("summary", (ctx) => cmd.handleSummary(ctx))
		this.bot.command("channels", (ctx) => cmd.handleChannels(ctx))
		this.bot.command("profile", (ctx) => cmd.handleProfile(ctx))
		this.bot.command("fetch", (ctx) => cmd.handleFetch(ctx))
		this.bot.command("minus_words", (ctx) => cmd.handleMinusWords(ctx))
		this.bot.command("digest_max", (ctx) => cmd.handleDigestMax(ctx))
		this.bot.command("digest_format", (ctx) => cmd.handleDigestFormat(ctx))
		this.bot.command("menu", (ctx) => cmd.handleStart(ctx))
		this.bot.command("add", (ctx) => cmd.handleAdd(ctx))
		this.bot.command("remove", (ctx) => cmd.handleRemove(ctx))

		// Admin commands
		this.bot.command("stats", (ctx) => admin.handleStats(ctx))
		this.bot.command("ban", (ctx) => admin.handleBan(ctx))
		this.bot.command("unban", (ctx) => admin.handleUnban(ctx))
		this.bot.command("open", (ctx) => admin.handleOpen(ctx, true))
		this.bot.command("close", (ctx) => admin.handleOpen(ctx, false))
	}

	_registerActions() {
		const { action: act } = this.handlers

		this.bot.action(/^more:(\d+):(\d+)$/, (ctx) => act.handleMore(ctx))
		this.bot.action(/^why:(.+)$/, (ctx) => act.handleWhy(ctx))
		this.bot.action(/^why_collapse:(.+)$/, (ctx) => act.handleWhyCollapse(ctx))
		this.bot.action(/^fb:(.+):(-?1)$/, (ctx) => act.handleFeedback(ctx))

		this.bot.action("digest", (ctx) => act.handleDigest(ctx))
		this.bot.action("summary", (ctx) => act.handleSummary(ctx))
		this.bot.action(/^summary_day:(.+)$/, (ctx) => act.handleSummaryDay(ctx))

		this.bot.action("audit_hide:(.+)$", (ctx) => act.handleAuditHide(ctx))
		this.bot.action("audit_all", (ctx) => act.handleAuditAll(ctx))
		this.bot.action("audit_hide_all_weak", (ctx) => act.handleAuditHideAll(ctx))
		this.bot.action(/^fetch:(\d+)$/, (ctx) => act.handleFetchDays(ctx))
	}

	_registerHandlers() {
		const { command: cmd } = this.handlers

		// Обработчик репостов из каналов — добавляет канал автоматически
		this.bot.on("message", async (ctx, next) => {
			const userId = ctx.from?.id
			if (!userId || isUserBanned(userId)) return next()

			if (ctx.message.forward_from_chat?.type === "channel") {
				const chat = ctx.message.forward_from_chat
				const username = chat.username || String(chat.id)
				const res = addChannel(username, userId)
				if (res.ok) {
					await ctx.reply(`✅ Канал @${res.username} добавлен!`)
				} else if (res.exists) {
					await ctx.reply(`ℹ️ Канал @${res.username} уже в списке.`)
				}
				return next()
			}

			return next()
		})

		// Обработчик текста (включая кнопки reply-клавиатуры)
		this.bot.on("text", async (ctx, next) => {
			const userId = ctx.from?.id
			if (!userId || isUserBanned(userId)) return

			const text = ctx.message.text?.trim()
			console.log("[BotManager text] userId:", userId, "text:", JSON.stringify(text))

			// Обработка кнопок reply-клавиатуры
			if (text === BTN_DIGEST) return cmd.handleDigest(ctx)
			if (text === BTN_SUMMARY) return cmd.handleSummary(ctx)
			if (text === BTN_CHANNELS) return cmd.handleChannels(ctx)
			if (text === BTN_PROFILE) return cmd.handleProfile(ctx)
			if (text === BTN_SETTINGS) return cmd.handleSettings(ctx)
			if (text === BTN_ANALYZE_CHANNEL) return cmd.handleCmdAnalyzeChannel(ctx)
			if (text === BTN_CHANNEL_AUDIT) return cmd.handleChannelAudit(ctx)
			if (text === BTN_BACK) return cmd.handleBack(ctx)
			if (text === BTN_FETCH) return cmd.handleFetchMenu(ctx)

			// Обработка команд из настроек
			if (text === BTN_MINUS_WORDS) {
				console.log("[BotManager] Minus words button clicked, userId:", userId)
				const user = getOrCreateUser(userId)
				return ctx.reply(`Текущие минус-слова: ${user.minus_keywords || "Нет"}\n\nОтправьте: <code>minus word1, word2</code>`, { parse_mode: "HTML" })
			}
			if (text === BTN_DIGEST_MAX_ITEMS) {
				console.log("[BotManager] Digest max items button clicked, userId:", userId)
				const user = getOrCreateUser(userId)
				return ctx.reply(`Текущий размер дайджеста: ${user.digest_max_items || 7}\n\nОтправьте: <code>max 10</code>`, { parse_mode: "HTML" })
			}
			if (text === BTN_DIGEST_FORMAT) {
				const user = getOrCreateUser(userId)
				return ctx.reply(`Текущий формат: ${user.digest_format || "full"}\n\nОтправьте: <code>format full</code> или <code>format compact</code>`, { parse_mode: "HTML" })
			}
			if (text === BTN_EDIT_PROFILE) {
				const user = getOrCreateUser(userId)
				return ctx.reply(`Текущие интересы: ${user.profile || "Не установлены"}\n\nОтправьте: <code>context ваши интересы</code>`, { parse_mode: "HTML" })
			}
			if (text === BTN_ADD_CHANNEL) {
				return ctx.reply("➕ <b>Добавить канал:</b>\n\nОтправьте: <code>/add @channel</code>\nНапример: <code>/add @durov</code>", { parse_mode: "HTML" })
			}
			if (text === BTN_REMOVE_CHANNEL) {
				return ctx.reply("➖ <b>Удалить канал:</b>\n\nОтправьте: <code>/remove @channel</code>\nНапример: <code>/remove @durov</code>", { parse_mode: "HTML" })
			}

			const handled = await cmd.handleText(ctx)
			if (handled) return

			return next()
		})
	}

	launch() {
		this.bot.launch()
		console.log("Bot launched.")
	}
}
