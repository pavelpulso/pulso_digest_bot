import { BaseHandler } from "./BaseHandler.js"
import { KeyboardProvider } from "../ui/KeyboardProvider.js"
import { UIFormatter } from "../ui/UIFormatter.js"
import { StatusMessage } from "../services/StatusMessage.js"
import {
	getOrCreateUser,
	isUserBanned,
	getChannels,
	upsertPostFeedback,
	setUserChannelHidden,
	getPostsForCalendarDay
} from "../db.js"
import { formatDateLabel } from "../utils.js"
import { collectChannelPosts } from "../gramjs.js"

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
		const { block, postById, reason } = cached
		const fullText = UIFormatter.formatBlockText(block, postById, { compact: false })
		const expanded = fullText + (reason ? `\n\n📌 <b>Почему в дайджесте:</b>\n${UIFormatter.escapeHtml(reason)}` : "")

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
		await this.safeAnswerCbQuery(ctx, "⏳ Собираю дайджест…")
		return this.mgr.handlers.command.handleDigest(ctx)
	}

	async handleSummary(ctx) {
		await this.safeAnswerCbQuery(ctx)
		await ctx.editMessageText("📅 <b>Выберите дату для дайджеста:</b>", { parse_mode: "HTML", reply_markup: KeyboardProvider.summaryDate().reply_markup })
	}

	async handleSummaryDay(ctx) {
		const dateStr = ctx.match[1]
		const userId = ctx.from?.id

		console.log("[handleSummaryDay] dateStr:", dateStr, "userId:", userId)

		if (!userId || isUserBanned(userId)) {
			console.log("[handleSummaryDay] user banned or missing")
			return this.safeAnswerCbQuery(ctx)
		}

		try {
			await this.safeAnswerCbQuery(ctx)

			const status = new StatusMessage(ctx)
			await status.startProgress("⏳ <b>Подготовка дайджеста за выбранную дату...</b>", 0)

			// Этап 1: Загрузка постов (0-30%)
			await status.percent("⏳ <b>Загружаю посты...</b>", 15)
			const user = getOrCreateUser(userId)
			const date = dateStr
			const label = formatDateLabel(date)

			// Проверяем наличие постов за выбранную дату
			const posts = getPostsForCalendarDay(date)
			if (posts.length === 0) {
				// Выкачиваем посты по каналам за выбранный день
				await status.percent("⏳ <b>Постов нет — выкачиваю из каналов...</b>", 25)
				const sinceTs = Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000)
				const untilTs = sinceTs + 24 * 60 * 60
				await collectChannelPosts({
					sinceTs,
					untilTs,
					onProgress: async ({ channel, index, total, collected }) => {
						const pct = Math.round(25 + (index / total) * 40)
						const progressText = `⏳ <b>Выкачиваю посты...</b>\n\n` +
							`${pct}% (${index}/${total} каналов)\n` +
							`📥 Собрано: ${collected} постов\n` +
							`📌 Сейчас: @${channel}`
						await status.update(progressText)
					}
				})
				await status.percent("⏳ <b>Посты выкачаны...</b>", 65)
			}

			// Этап 2: Ранжирование (30-70%)
			await status.percent("⏳ <b>Ранжирую посты...</b>", 70)
			await this.mgr.service.ensureRankingsForDate(userId, date, user.profile || "")
			await status.percent("⏳ <b>Ранжирую посты...</b>", 80)

			// Этап 3: Генерация блоков (80-100%)
			await status.percent("⏳ <b>Генерирую блоки...</b>", 90)
			await this.mgr.service.sendSummaryBlocks(ctx, date, label, 0, {
				messageToEdit: ctx.callbackQuery?.message?.message_id,
				status
			})

			// Завершение (100%)
			await status.replace("✅ <b>Дайджест готов!</b>")
		} catch (e) {
			console.error("[handleSummaryDay] error:", e)
			const userMsg = this.formatErrorForChat(e)
			await status.replace("❌ <b>Не удалось создать дайджест</b>\n\n" + userMsg)
		}
	}

	async handleChannels(ctx) {
		await this.safeAnswerCbQuery(ctx, "⏳ Загружаю список каналов…")
		const channels = getChannels()
		await ctx.editMessageText(formatChannelList(channels), KeyboardProvider.channels())
	}

	async handleProfile(ctx) {
		await this.safeAnswerCbQuery(ctx, "⏳ Загружаю профиль…")
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

	async handleFetchDays(ctx) {
		if (!this.mgr.handlers.admin.isAdmin(ctx.from?.id)) {
			return this.safeAnswerCbQuery(ctx, "Только администратор")
		}
		const days = parseInt(ctx.match[1], 10)
		await this.safeAnswerCbQuery(ctx)
		await ctx.editMessageText(`🔄 Сбор постов за ${days} д...`)

		const nowTs = Math.floor(Date.now() / 1000)
		const sinceTs = nowTs - (days * 24 * 60 * 60)

		const status = new StatusMessage(ctx)
		status.messageId = ctx.callbackQuery?.message?.message_id
		status.chatId = ctx.chat?.id

		const startTime = Date.now()
		const { collected, errors, perChannel } = await collectChannelPosts({
			sinceTs,
			onProgress: async ({ channel, index, total, collected: currentCollected }) => {
				const pct = Math.round((index / total) * 100)
				const elapsed = Math.round((Date.now() - startTime) / 1000)
				const progressText = `🔄 Сбор постов за ${days} д...\n\n` +
					`${pct}% (${index}/${total} каналов)\n` +
					`📥 Собрано: ${currentCollected} постов\n` +
					`⏱ Прошло: ${elapsed}с\n` +
					`📌 Сейчас: @${channel}`
				await status.update(progressText)
			}
		})

		const elapsed = Math.round((Date.now() - startTime) / 1000)
		let resultText = `✅ Сбор завершён\n\n` +
			`📥 Собрано: ${collected} постов\n` +
			`⏱ Всего: ${elapsed}с`
		if (errors.length > 0) {
			resultText += `\n⚠️ Ошибки: ${errors.length}`
			resultText += `\n${errors.slice(0, 5).map(e => `• ${e}`).join("\n")}`
			if (errors.length > 5) resultText += `\n... и ещё ${errors.length - 5}`
		}
		if (perChannel.length > 0) {
			resultText += `\n\nПо каналам:\n` +
				perChannel.map(c => `• @${c.channel}: ${c.count}`).join("\n")
		}

		await status.replace(resultText)
	}
}
