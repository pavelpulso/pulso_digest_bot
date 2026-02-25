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
} from "../db.js"
import gemini from "../gemini.js"

export class BotManager {
	constructor(token) {
		this.bot = new Telegraf(token)
		this.cache = new BotCache()
		this.ai = gemini
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
		this.bot.action("channels", (ctx) => act.handleChannels(ctx))
		this.bot.action("profile", (ctx) => act.handleProfile(ctx))

		this.bot.action(/^audit_hide:(.+)$/, (ctx) => act.handleAuditHide(ctx))
		this.bot.action("audit_all", (ctx) => act.handleAuditAll(ctx))
		this.bot.action("audit_hide_all_weak", (ctx) => act.handleAuditHideAll(ctx))
	}

	_registerHandlers() {
		const { command: cmd } = this.handlers

		this.bot.on("text", async (ctx, next) => {
			const userId = ctx.from?.id
			if (!userId || isUserBanned(userId)) return

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
