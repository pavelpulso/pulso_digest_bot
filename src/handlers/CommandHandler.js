import { BaseHandler } from "./BaseHandler.js"
import { KeyboardProvider } from "../ui/KeyboardProvider.js"
import { UIFormatter } from "../ui/UIFormatter.js"
import {
	getOrCreateUser,
	getUser,
	getChannelUsernames,
	getRecentPostsByChannel,
	getChannels,
	addChannel,
	removeChannel,
	updateUserMinusKeywords,
	updateUserProfile,
	updateUserDigestMax,
	setDigestFormat,
	isUserBanned
} from "../db.js"
import { formatChannelList } from "../utils.js"
import { collectChannelPosts } from "../gramjs.js"

export class CommandHandler extends BaseHandler {
	async handleStart(ctx) {
		const userId = ctx.from?.id
		if (!userId) return

		if (!isBotOpen()) {
			const existing = getUser(userId)
			if (!existing) return ctx.reply("Bot is closed to new users.")
		}

		getOrCreateUser(userId, ctx.from?.username ? String(ctx.from.username).toLowerCase() : null)
		if (isUserBanned(userId)) return ctx.reply("You are blocked.")

		await ctx.reply(
			"Hi! I collect posts from your channels and build a digest.\n\n" +
			"Use the buttons below or:\n" +
			"/digest — top posts for today\n" +
			"/profile — set interests for personalization\n" +
			"/summary — digest for a chosen day\n" +
			"/channels — list of channels\n" +
			"/add @channel — add a channel\n" +
			"/remove @channel — remove a channel\n" +
			"/analyze_channel @channel — score a channel for you\n" +
			"/channel_audit — audit all channels, find weak ones\n\n" +
			"You can forward a post from a channel — the channel will be added automatically.",
			KeyboardProvider.mainReply()
		)
		await ctx.reply("Choose an action:", KeyboardProvider.mainMenu())
	}

	async handleDigest(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return

		const user = getOrCreateUser(userId)
		const date = this.mgr.service.todayDate()

		const hasRankings = this.mgr.service.hasRankings(userId, date)
		if (!hasRankings) {
			const loading = await ctx.reply("Ranking posts for your profile…")
			try {
				await this.mgr.service.ensureRankings(userId, user.profile || "")
			} catch (e) {
				await ctx.telegram.editMessageText(
					ctx.chat.id,
					loading.message_id,
					null,
					"Failed to get ranking (Gemini error). Try again later.\n\nError: " + this.formatErrorForChat(e)
				)
				return
			}
			await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id)
		}

		return this.mgr.service.digestReply(ctx, 0)
	}

	async handleAnalyzeChannel(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return

		const arg = (ctx.message?.text || "").replace(/^\/analyze_channel\s*/i, "").trim()
		const channelName = arg.replace(/^@/, "").toLowerCase()

		if (!channelName) {
			return ctx.reply(
				"Укажи канал: <code>/analyze_channel @channel</code>\n" +
				"Например: <code>/analyze_channel durov</code>",
				{ parse_mode: "HTML" }
			)
		}

		const posts = getRecentPostsByChannel(channelName, 20)

		if (posts.length === 0) {
			return ctx.reply(
				`❓ Нет данных по каналу <b>@${UIFormatter.escapeHtml(channelName)}</b>.\n\n` +
				`Убедись что канал добавлен (/channels) и посты собраны (/fetch или автосбор утром).`,
				{ parse_mode: "HTML" }
			)
		}

		const minWarning = posts.length < 5 ? `\n⚠️ <i>Мало данных (${posts.length} постов) — оценка приблизительная.</i>` : ""
		const loadingMsg = await ctx.reply(`🔍 Анализирую @${channelName}…`)

		const user = getOrCreateUser(userId)
		try {
			const result = await this.mgr.ai.analyzeChannel(posts, channelName, user.profile || "")
			await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { })

			const { emoji, label: vLabel } = UIFormatter.verdictLabel(result.verdict)
			const snPct = Math.round((result.signal_noise || 0) * 100)
			const args = result.arguments.map((a) => `• ${UIFormatter.escapeHtml(a)}`).join("\n")

			const text =
				`📊 <b>Анализ канала @${UIFormatter.escapeHtml(channelName)}</b> (${posts.length} постов)${minWarning}\n\n` +
				`⭐ <b>Скор:</b> ${result.score.toFixed(1)}/10\n` +
				`📶 <b>Сигнал/шум:</b> ${snPct}%\n` +
				`${emoji} <b>Вердикт:</b> ${vLabel}\n\n` +
				`<i>${UIFormatter.escapeHtml(result.summary)}</i>\n\n` +
				(args ? `<b>Аргументы:</b>\n${args}` : "")

			const keyboard = {
				reply_markup: {
					inline_keyboard: [
						[
							{ text: "🙈 Скрыть из дайджеста", callback_data: `audit_hide:${channelName}` },
							{ text: "📋 Аудит всех каналов", callback_data: "audit_all" }
						]
					]
				}
			}

			await ctx.reply(text, { parse_mode: "HTML", disable_web_page_preview: true, ...keyboard })
		} catch (e) {
			await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { })
			return ctx.reply("Не удалось проанализировать канал: " + this.formatErrorForChat(e))
		}
	}

	async handleChannelAudit(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return

		const channels = getChannelUsernames()
		if (channels.length === 0) return ctx.reply("Нет каналов.")

		const loadingMsg = await ctx.reply(`⏳ Анализирую ${channels.length} каналов…`)

		const channelsData = channels.map((ch) => ({
			channel: ch.toLowerCase(),
			posts: getRecentPostsByChannel(ch, 20)
		}))

		const channelsWithData = channelsData.filter((cd) => cd.posts.length > 0)
		const noDataChannels = channelsData.filter((cd) => cd.posts.length === 0).map((cd) => cd.channel)

		if (channelsWithData.length === 0) {
			await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { })
			return ctx.reply("Нет данных ни по одному каналу.")
		}

		const user = getOrCreateUser(userId)
		try {
			let scores = await this.mgr.ai.auditAllChannels(channelsWithData, user.profile || "")
			await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { })

			const scored = new Set(scores.map((s) => s.channel))
			for (const ch of channelsWithData.map((c) => c.channel)) {
				if (!scored.has(ch)) scores.push({ channel: ch, score: 0, verdict: "mute", summary: "Нет данных" })
			}
			scores.sort((a, b) => b.score - a.score)

			const weakChannels = scores.filter((s) => s.score < 4)
			const lines = scores.map((s) => {
				const { emoji } = UIFormatter.verdictLabel(s.verdict)
				return `${emoji} @${UIFormatter.escapeHtml(s.channel)} — ${s.score.toFixed(1)} — <i>${UIFormatter.escapeHtml(s.summary)}</i>`
			})

			const noDataNote = noDataChannels.length > 0 ? `\n\n⚠️ <i>Нет постов по: ${noDataChannels.map((c) => "@" + c).join(", ")}</i>` : ""
			const weakNote = weakChannels.length > 0 ? `\n\n🔴 <b>Слабые каналы (score < 4):</b> ${weakChannels.map((s) => "@" + s.channel).join(", ")}` : ""

			const header = `📋 <b>Аудит каналов</b> (${channels.length} каналов)\n\n`
			const body = lines.join("\n") + noDataNote + weakNote

			const hideButtons = weakChannels.slice(0, 4).map((s) => ({
				text: `🙈 @${s.channel}`,
				callback_data: `audit_hide:${s.channel}`
			}))
			const hideAllBtn = weakChannels.length > 0 ? [{ text: `🔕 Скрыть все слабые (${weakChannels.length})`, callback_data: "audit_hide_all_weak" }] : []

			const inlineRows = []
			for (let i = 0; i < hideButtons.length; i += 2) inlineRows.push(hideButtons.slice(i, i + 2))
			if (hideAllBtn.length > 0) inlineRows.push(hideAllBtn)

			const keyboard = inlineRows.length > 0 ? { reply_markup: { inline_keyboard: inlineRows } } : {}
			const fullText = header + body
			const safeText = fullText.length > 4096 ? fullText.slice(0, 4093) + "…" : fullText

			this.mgr.cache.setAuditWeak(userId, weakChannels.map((s) => s.channel))
			await ctx.reply(safeText, { parse_mode: "HTML", disable_web_page_preview: true, ...keyboard })
		} catch (e) {
			await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { })
			return ctx.reply("Ошибка анализа: " + this.formatErrorForChat(e))
		}
	}
	async handleSummary(ctx) {
		await ctx.reply("Choose date for summary:", KeyboardProvider.summaryDate())
	}

	async handleChannels(ctx) {
		const channels = getChannels()
		await ctx.reply(formatChannelList(channels), KeyboardProvider.channels())
	}

	async handleProfile(ctx) {
		const userId = ctx.from?.id
		const user = getOrCreateUser(userId)
		await ctx.reply(this.mgr.service.renderProfileText(userId, user), KeyboardProvider.profile())
	}

	async handleFetch(ctx) {
		if (!this.mgr.handlers.admin.isAdmin(ctx.from?.id)) return
		await ctx.reply("⏳ Collecting posts...")
		const { collected, errors } = await collectChannelPosts()
		let msg = `✅ Collected ${collected} posts.`
		if (errors.length) msg += `\n⚠️ Errors: ${errors.length}`
		await ctx.reply(msg)
	}

	async handleMinusWords(ctx) {
		const arg = ctx.message.text.replace(/^\/minus_words\s*/i, "").trim()
		const userId = ctx.from?.id
		if (!arg) {
			const user = getOrCreateUser(userId)
			return ctx.reply(`Current minus keywords: ${user.minus_keywords || "None"}\nUse /minus_words word1, word2 to update.`)
		}
		updateUserMinusKeywords(userId, arg)
		await ctx.reply("✅ Minus keywords updated.")
	}

	async handleDigestMax(ctx) {
		const arg = ctx.message.text.replace(/^\/digest_max\s*/i, "").trim()
		const num = parseInt(arg, 10)
		if (isNaN(num)) return ctx.reply("Usage: /digest_max 10")
		updateUserDigestMax(ctx.from.id, num)
		await ctx.reply(`✅ Max digest items set to ${num}`)
	}

	async handleDigestFormat(ctx) {
		const arg = ctx.message.text.replace(/^\/digest_format\s*/i, "").trim().toLowerCase()
		if (arg !== "full" && arg !== "compact") return ctx.reply("Usage: /digest_format full OR /digest_format compact")
		setDigestFormat(ctx.from.id, arg)
		await ctx.reply(`✅ Digest format set to ${arg}`)
	}
	async handleAdd(ctx) {
		const arg = ctx.message.text.replace(/^\/add\s*/i, "").trim()
		if (!arg) return ctx.reply("Usage: /add @channel")
		const res = addChannel(arg, ctx.from.id)
		await ctx.reply(res.ok ? `Success: @${res.username}` : "Already exists.")
	}

	async handleRemove(ctx) {
		const arg = ctx.message.text.replace(/^\/remove\s*/i, "").trim()
		if (!arg) return ctx.reply("Usage: /remove @channel")
		const ok = removeChannel(arg)
		await ctx.reply(ok ? "Removed." : "Not found.")
	}

	async handleText(ctx) {
		const userId = ctx.from?.id
		const text = ctx.message.text?.trim()
		if (!text) return false

		// Forwarded content logic
		if (ctx.message.forward_from_chat) {
			const chat = ctx.message.forward_from_chat
			if (chat.type === "channel") {
				const username = chat.username || chat.id
				const res = addChannel(String(username), userId)
				await ctx.reply(res.ok ? `Success: Added @${res.username}` : "Channel already exists.")
				return true
			}
		}

		if (text.startsWith("context ")) {
			updateUserProfile(userId, text.replace("context ", "").trim())
			await ctx.reply("✅ Profile interests updated.")
			return true
		}
		if (text.startsWith("max ")) {
			const num = parseInt(text.replace("max ", "").trim(), 10)
			if (!isNaN(num)) {
				updateUserDigestMax(userId, num)
				await ctx.reply(`✅ Digest max items: ${num}`)
				return true
			}
		}
		if (text.startsWith("minus ")) {
			updateUserMinusKeywords(userId, text.replace("minus ", "").trim())
			await ctx.reply("✅ Minus keywords updated.")
			return true
		}
		if (text.startsWith("format ")) {
			const f = text.replace("format ", "").trim().toLowerCase()
			if (f === "full" || f === "compact") {
				setDigestFormat(userId, f)
				await ctx.reply(`✅ Digest format: ${f}`)
				return true
			}
		}
		return false
	}
}

