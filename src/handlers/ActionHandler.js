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
	getPostsForCalendarDay,
	removeChannelsByUsernames
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

	async handleRemoveWeakChannels(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const weakChannels = this.mgr.cache.getAuditWeak(userId)
		if (!weakChannels || weakChannels.length === 0) {
			return this.safeAnswerCbQuery(ctx, "Нет слабых каналов для удаления")
		}

		await this.safeAnswerCbQuery(ctx, `🗑 Удаляю ${weakChannels.length} каналов...`)

		const removed = removeChannelsByUsernames(weakChannels)
		this.mgr.cache.deleteAuditWeak(userId)

		try {
			await ctx.editMessageText(`✅ Удалено ${removed} слабых каналов:\n${weakChannels.slice(0, 10).map(c => `@${c}`).join("\n")}${weakChannels.length > 10 ? `\n... и ещё ${weakChannels.length - 10}` : ""}`)
		} catch (_) { }
	}

	async handleFullReport(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const scores = this.mgr.cache.getAuditScores(userId)
		if (!scores || scores.length === 0) {
			return this.safeAnswerCbQuery(ctx, "Нет данных аудита")
		}

		await this.safeAnswerCbQuery(ctx)

		// Формируем полный отчёт с score breakdown
		const lines = scores.map((s, i) => {
			const emoji = { keep: "🟢", review: "🟡", mute: "🔴" }[s.verdict] || "⚪"
			const problemLabel = s.problemType && s.problemType !== "none" ? `| ${s.problemType}` : ""
			const qualityPct = Math.round(s.scoreBreakdown.quality * 100)
			const relevancePct = Math.round(s.scoreBreakdown.relevance * 100)
			const spamFreePct = Math.round(s.scoreBreakdown.spamFree * 100)
			const recText = s.recommendation === "keep_if" && s.keepIfCondition ? `\n   ⚠️ Оставить если: ${s.keepIfCondition}` : ""
			return `${i + 1}. ${emoji} @${s.channel} — ${s.score.toFixed(1)} ${problemLabel}\n   ${s.summary}\n   Оценка: Q:${qualityPct}% R:${relevancePct}% S:${spamFreePct}%\n   ${s.reason || ""}${recText}`
		})

		const reportText = `📊 <b>Полный отчёт: ${scores.length} каналов</b>\n\n` + lines.join("\n\n")
		const safeText = reportText.length > 4096 ? reportText.slice(0, 4093) + "…" : reportText

		try {
			await ctx.editMessageText(safeText, { parse_mode: "HTML", disable_web_page_preview: true })
		} catch (e) {
			// Если не влезает в одно сообщение — отправляем частями
			await ctx.reply(safeText, { parse_mode: "HTML", disable_web_page_preview: true })
		}
	}

	async handleOptimize(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const scores = this.mgr.cache.getAuditScores(userId)
		if (!scores || scores.length === 0) {
			return this.safeAnswerCbQuery(ctx, "Нет данных аудита")
		}

		const muteChannels = scores.filter(s => s.verdict === "mute")
		const keepChannels = scores.filter(s => s.verdict !== "mute")
		
		if (muteChannels.length === 0) {
			return this.safeAnswerCbQuery(ctx, "Нет каналов для удаления")
		}

		await this.safeAnswerCbQuery(ctx)

		// Превью оптимизации
		const currentAvg = (scores.reduce((sum, s) => sum + s.score, 0) / scores.length).toFixed(1)
		const newAvg = (keepChannels.reduce((sum, s) => sum + s.score, 0) / Math.max(1, keepChannels.length)).toFixed(1)
		const timeSaved = muteChannels.length * 3 // ~3 мин на канал в день

		const previewText = `⚡ <b>Оптимизация ленты</b>\n\n` +
			`<b>Сейчас:</b> ${scores.length} каналов, средний score: ${currentAvg}\n` +
			`<b>После:</b> ${keepChannels.length} каналов, средний score: ${newAvg}\n\n` +
			`<b>Удалить (${muteChannels.length}):</b>\n` +
			muteChannels.slice(0, 10).map(c => `@${c.channel}`).join("\n") +
			(muteChannels.length > 10 ? `\n... и ещё ${muteChannels.length - 10}` : "") +
			`\n\n<i>~${timeSaved} мин в день сэкономлено</i>`

		const keyboard = {
			reply_markup: {
				inline_keyboard: [
					[
						{ text: "✅ Подтвердить удаление", callback_data: "optimize_confirm" },
						{ text: "❌ Отмена", callback_data: "optimize_cancel" }
					]
				]
			}
		}

		try {
			await ctx.editMessageText(previewText, { parse_mode: "HTML", ...keyboard })
		} catch (_) {
			await ctx.reply(previewText, { parse_mode: "HTML", ...keyboard })
		}
	}

	async handleOptimizeConfirm(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const scores = this.mgr.cache.getAuditScores(userId)
		if (!scores) return this.safeAnswerCbQuery(ctx, "Нет данных аудита")

		const muteChannels = scores.filter(s => s.verdict === "mute").map(s => s.channel)
		if (muteChannels.length === 0) {
			return this.safeAnswerCbQuery(ctx, "Нет каналов для удаления")
		}

		await this.safeAnswerCbQuery(ctx, `🗑 Удаляю ${muteChannels.length} каналов...`)

		const removed = removeChannelsByUsernames(muteChannels)
		this.mgr.cache.deleteAuditScores(userId)
		this.mgr.cache.deleteAuditWeak(userId)

		const keepChannels = scores.filter(s => s.verdict !== "mute")
		const newAvg = (keepChannels.reduce((sum, s) => sum + s.score, 0) / Math.max(1, keepChannels.length)).toFixed(1)

		try {
			await ctx.editMessageText(`✅ Оптимизация завершена!\n\nУдалено: ${removed} каналов\nОсталось: ${keepChannels.length} каналов\nСредний score: ${newAvg}`)
		} catch (_) {
			await ctx.reply(`✅ Оптимизация завершена!\n\nУдалено: ${removed} каналов\nОсталось: ${keepChannels.length} каналов\nСредний score: ${newAvg}`)
		}
	}

	async handleOptimizeCancel(ctx) {
		await this.safeAnswerCbQuery(ctx, "❌ Отменено")
		try {
			await ctx.editMessageText("❌ Оптимизация отменена")
		} catch (_) { }
	}
}
