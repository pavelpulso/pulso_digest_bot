import { BaseHandler } from "./BaseHandler.js"
import { KeyboardProvider } from "../ui/KeyboardProvider.js"
import { UIFormatter } from "../ui/UIFormatter.js"
import {
	getOrCreateUser,
	isUserBanned,
	getChannels,
	upsertPostFeedback,
	setUserChannelHidden
} from "../db.js"
import { formatChannelList } from "../utils.js"

export class ActionHandler extends BaseHandler {
	async handleMore(ctx) {
		const offset = parseInt(ctx.match[1], 10)
		const count = parseInt(ctx.match[2], 10)
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return
		await this.safeAnswerCbQuery(ctx, "Формирую…")
		return this.mgr.service.digestReply(ctx, offset, count)
	}

	async handleWhy(ctx) {
		const postId = ctx.match[1]
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const cached = this.mgr.cache.getBlock(postId)
		if (!cached) {
			const r = this.mgr.service.getRanking(userId, postId)
			if (!r?.reason) return this.safeAnswerCbQuery(ctx, "Объяснение недоступно")
			await this.safeAnswerCbQuery(ctx)
			return ctx.reply(`📌 <b>Почему в дайджесте:</b>\n\n${UIFormatter.escapeHtml(r.reason)}`, { parse_mode: "HTML" })
		}

		await this.safeAnswerCbQuery(ctx)
		const { normalText, reason } = cached
		const expanded = normalText + (reason ? `\n\n📌 <b>Почему в дайджесте:</b>\n${UIFormatter.escapeHtml(reason)}` : "")

		try {
			await ctx.editMessageText(expanded, {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...KeyboardProvider.blockKeyboard(postId, false, true)
			})
		} catch (_) { }
	}

	async handleWhyCollapse(ctx) {
		const postId = ctx.match[1]
		const cached = this.mgr.cache.getBlock(postId)
		if (!cached) return this.safeAnswerCbQuery(ctx, "Невозможно свернуть")

		await this.safeAnswerCbQuery(ctx)
		try {
			await ctx.editMessageText(cached.normalText, {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...KeyboardProvider.blockKeyboard(postId, !!cached.reason, false)
			})
		} catch (_) { }
	}

	async handleFeedback(ctx) {
		const postId = ctx.match[1]
		const rating = parseInt(ctx.match[2], 10)
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		upsertPostFeedback(userId, postId, rating)
		await this.safeAnswerCbQuery(ctx, "Спасибо, учту")
	}

	async handleDigest(ctx) {
		await this.safeAnswerCbQuery(ctx)
		return this.mgr.handlers.command.handleDigest(ctx)
	}

	async handleSummary(ctx) {
		await this.safeAnswerCbQuery(ctx)
		await ctx.editMessageText("Choose date for summary:", KeyboardProvider.summaryDate())
	}

	async handleChannels(ctx) {
		await this.safeAnswerCbQuery(ctx)
		const channels = getChannels()
		await ctx.editMessageText(formatChannelList(channels), KeyboardProvider.channels())
	}

	async handleProfile(ctx) {
		await this.safeAnswerCbQuery(ctx)
		const userId = ctx.from?.id
		const user = getOrCreateUser(userId)
		await ctx.editMessageText(this.mgr.service.renderProfileText(userId, user), KeyboardProvider.profile())
	}

	async handleAuditHide(ctx) {
		const channel = ctx.match[1]
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		setUserChannelHidden(userId, channel, true)
		await this.safeAnswerCbQuery(ctx, `🙈 @${channel} скрыт`)

		try {
			const oldMarkup = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || []
			const newRows = oldMarkup
				.map((row) => row.filter((btn) => btn.callback_data !== `audit_hide:${channel}`))
				.filter((row) => row.length > 0)
			await ctx.editMessageReplyMarkup({ inline_keyboard: newRows })
		} catch (_) { }
	}

	async handleAuditAll(ctx) {
		await this.safeAnswerCbQuery(ctx)
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return
		await ctx.telegram.sendMessage(ctx.chat.id, "/channel_audit — запусти командой для полного аудита.")
	}

	async handleAuditHideAll(ctx) {
		const userId = ctx.from?.id
		const weak = this.mgr.cache.getAuditWeak(userId) || []
		if (weak.length === 0) return this.safeAnswerCbQuery(ctx, "Нет данных")

		for (const ch of weak) setUserChannelHidden(userId, ch, true)
		await this.safeAnswerCbQuery(ctx, `🔕 Скрыто ${weak.length} каналов`)
		this.mgr.cache.deleteAuditWeak(userId)
		try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }) } catch (_) { }
	}
}
