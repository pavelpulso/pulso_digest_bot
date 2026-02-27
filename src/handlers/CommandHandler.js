import { BaseHandler } from "./BaseHandler.js"
import { KeyboardProvider } from "../ui/KeyboardProvider.js"
import { UIFormatter } from "../ui/UIFormatter.js"
import { StatusMessage } from "../services/StatusMessage.js"
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
	isUserBanned,
	isBotOpen,
	getPostsForCalendarDay
} from "../db.js"
import { DIGEST_PAGE_SIZE } from "../utils.js"
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

		const text =
			"Hi! I collect posts from your channels and build a digest.\n\n" +
			"Use the buttons below:\n\n" +
			"📰 <b>Digest</b> — top posts for today\n" +
			"📋 <b>Summary</b> — digest for a chosen day\n" +
			"📢 <b>Channels</b> — list of channels\n" +
			"👤 <b>Profile</b> — set your interests\n" +
			"🔍 <b>Analyze Channel</b> — score a channel for you\n" +
			"📊 <b>Channel Audit</b> — audit all channels\n" +
			"⚙️ <b>Settings</b> — digest settings\n\n" +
			"You can forward a post from a channel — the channel will be added automatically."

		await ctx.reply(text, KeyboardProvider.mainReply())
	}

	async handleDigest(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return

		const status = new StatusMessage(ctx)
		await status.startProgress("⏳ <b>Начинаю подготовку дайджеста...</b>", 0)

		const user = getOrCreateUser(userId)
		const date = this.mgr.service.todayDate()

		// Этап 1: Подготовка данных (0-20%)
		await status.percent("⏳ <b>Подготовка данных...</b>", 10)
		
		// Проверяем наличие постов за сегодня
		const posts = getPostsForCalendarDay(date)
		if (posts.length === 0) {
			// Выкачиваем посты за последние 24 часа
			await status.percent("⏳ <b>Постов нет — выкачиваю из каналов...</b>", 15)
			const nowTs = Math.floor(Date.now() / 1000)
			const sinceTs = nowTs - 24 * 60 * 60
			await collectChannelPosts({
				sinceTs,
				untilTs: nowTs,
				onProgress: async ({ channel, index, total, collected }) => {
					const pct = Math.round(15 + (index / total) * 50)
					const progressText = "⏳ <b>Выкачиваю посты...</b>\n\n" +
						`${pct}% (${index}/${total} каналов)\n` +
						`📥 Собрано: ${collected} постов\n` +
						`📌 Сейчас: @${channel}`
					await status.update(progressText)
				}
			})
			await status.percent("⏳ <b>Посты выкачаны...</b>", 65)
		}
		
		const hasRankings = this.mgr.service.hasRankings(userId, date)

		if (!hasRankings) {
			// Этап 2: Ранжирование постов (20-80%)
			await status.percent("⏳ <b>Ранжирую посты...</b>", 70)
			try {
				await this.mgr.service.ensureRankings(userId, user.profile || "")
				await status.percent("⏳ <b>Ранжирую посты...</b>", 80)
			} catch (e) {
				const userMsg = this.formatErrorForChat(e)
				await status.replace("❌ <b>Не удалось получить рейтинг</b>\n\n" + userMsg)
				return
			}
		} else {
			await status.percent("⏳ <b>Ранжирую посты...</b>", 80)
		}

		// Этап 3: Генерация блоков (80-100%)
		await status.percent("⏳ <b>Генерирую блоки дайджеста...</b>", 90)
		return this.mgr.service.digestReply(ctx, 0, DIGEST_PAGE_SIZE, status)
	}

	async handleAnalyzeChannel(ctx, channelName) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return

		// Если channelName не передан — берём из команды
		if (!channelName) {
			const arg = (ctx.message?.text || "").replace(/^\/analyze_channel\s*/i, "").trim()
			channelName = arg.replace(/^@/, "").toLowerCase()
		} else {
			channelName = channelName.toLowerCase()
		}

		if (!channelName) {
			return ctx.reply(
				"Укажи канал: <code>/analyze_channel @channel</code>\n" +
				"Например: <code>/analyze_channel durov</code>",
				{ parse_mode: "HTML" }
			)
		}

		const posts = getRecentPostsByChannel(channelName, 15)

		if (posts.length === 0) {
			return ctx.reply(
				`❓ Нет данных по каналу <b>@${UIFormatter.escapeHtml(channelName)}</b>.\n\n` +
				"Убедись что канал добавлен (/channels) и посты собраны (/fetch или автосбор утром).",
				{ parse_mode: "HTML" }
			)
		}

		const status = new StatusMessage(ctx)
		await status.start(`🔍 Анализирую @${channelName}...`)

		const minWarning = posts.length < 5 ? `\n⚠️ <i>Мало данных (${posts.length} постов) — оценка приблизительная.</i>` : ""
		const user = getOrCreateUser(userId)
		try {
			const result = await this.mgr.ai.analyzeChannel(posts, channelName, user.profile || "")

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

			await status.replace(text, { disable_web_page_preview: true, ...keyboard })
		} catch (e) {
			await status.replace("Не удалось проанализировать канал: " + this.formatErrorForChat(e))
		}
	}

	async handleCmdAnalyzeChannel(ctx) {
		const channels = getChannels()
		if (channels.length === 0) {
			return ctx.reply(
				"🔍 <b>Анализ канала:</b>\n\n" +
				"Нет каналов для анализа. Добавьте каналы через <code>/add @channel</code>",
				{ parse_mode: "HTML" }
			)
		}

		const channelList = channels.map((ch, i) => `${i + 1}. @${ch.username}`).join("\n")
		await ctx.reply(
			"🔍 <b>Анализ канала:</b>\n\n" +
			`Выберите канал для анализа:\n\n${channelList}\n\n` +
			"Или отправьте название канала:\n<code>@username</code>",
			{ parse_mode: "HTML", reply_markup: KeyboardProvider.analyzeChannelList(channels).reply_markup }
		)
	}

	async handleChannelAudit(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return

		const channels = getChannelUsernames()
		if (channels.length === 0) return ctx.reply("Нет каналов.")

		const channelsData = channels.map((ch) => {
			const posts = getRecentPostsByChannel(ch, 15)
			return {
				channel: ch.toLowerCase(),
				posts,
				postCount: posts.length
			}
		})

		const channelsWithData = channelsData.filter((cd) => cd.posts.length > 0)
		const noDataChannels = channelsData.filter((cd) => cd.posts.length === 0).map((cd) => cd.channel)

		if (channelsWithData.length === 0) {
			return ctx.reply("❌ Нет данных ни по одному каналу.")
		}

		const status = new StatusMessage(ctx)
		const batchCount = Math.ceil(channelsWithData.length / 15)
		await status.start(`<b>📊 Аудит каналов</b>\n\n⏳ Анализирую ${channelsWithData.length} каналов (${batchCount} батчей по 15)...`)

		const user = getOrCreateUser(userId)
		try {
			const scores = await this.mgr.ai.auditAllChannels(channelsWithData, user.profile || "", {
				onProgress: ({ analyzedChannels, totalChannels, percent, completedBatches, totalBatches }) => {
					status.percent(
						`⏳ Анализирую каналы...`,
						percent,
						`${analyzedChannels}/${totalChannels} каналов — ${completedBatches}/${totalBatches} батчей`
					)
				}
			})

			const scored = new Set(scores.map((s) => s.channel))
			for (const ch of channelsWithData.map((c) => c.channel)) {
				if (!scored.has(ch)) scores.push({ 
					channel: ch, 
					score: 0, 
					verdict: "mute", 
					summary: "Нет данных", 
					reason: "Не удалось получить посты", 
					problemType: "none",
					scoreBreakdown: { quality: 0, relevance: 0, spamFree: 1 },
					recommendation: "remove",
					keepIfCondition: ""
				})
			}
			scores.sort((a, b) => b.score - a.score)

			// Группировка по verdict
			const keepChannels = scores.filter((s) => s.verdict === "keep")
			const reviewChannels = scores.filter((s) => s.verdict === "review")
			const muteChannels = scores.filter((s) => s.verdict === "mute")

			// Форматирование строки канала
			const formatChannel = (s) => {
				const postCount = channelsData.find((cd) => cd.channel === s.channel)?.postCount || 0
				const postsLabel = postCount === 1 ? "пост" : postCount < 5 ? "поста" : "постов"
				const avgViews = s.avgViews && isFinite(s.avgViews) ? (s.avgViews >= 1000 ? `${(s.avgViews / 1000).toFixed(1)}K` : Math.round(s.avgViews)) : "—"
				const qualityPct = Math.round(s.scoreBreakdown.quality * 100)
				const relevancePct = Math.round(s.scoreBreakdown.relevance * 100)
				const spamFreePct = Math.round(s.scoreBreakdown.spamFree * 100)
				return `@${s.channel} — ${s.score.toFixed(1)} | 👁 ${avgViews} (${postCount} ${postsLabel})\n   ${s.summary}\n   Оценка: Q:${qualityPct}% R:${relevancePct}% S:${spamFreePct}%`
			}

			// Форматирование слабого канала с развёрнутым reason
			const formatWeakChannel = (s) => {
				const problemLabel = {
					spam: "Спам",
					irrelevant: "Не релевантно профилю",
					low_quality: "Низкое качество",
					promo: "Промо/реклама",
					outdated: "Устаревший контент",
					low_frequency: "Слишком редко",
					duplicate: "Дублирует другие каналы",
					noise: "Много шума/флуда",
					too_basic: "Слишком базовый уровень",
					none: "Низкая ценность"
				}[s.problemType] || "Низкая ценность"

				return `🔴 @${s.channel} — ${s.score.toFixed(1)}\n   Проблема: ${problemLabel}\n   ${s.reason}`
			}

			// Динамическое ограничение топ-N
			const totalChannels = scores.length
			const topLimit = totalChannels <= 10 ? 10 : (totalChannels <= 20 ? 8 : 5)
			const topChannels = [...keepChannels, ...reviewChannels].slice(0, topLimit)
			const topLines = topChannels.map((s) => {
				const emoji = s.verdict === "keep" ? "🟢" : "🟡"
				return `${emoji} ${formatChannel(s)}`
			})

			// Слабые каналы с развёрнутым reason
			const weakLines = muteChannels.map((s) => formatWeakChannel(s))

			// Сборка сообщения
			const sections = []
			if (topLines.length > 0) {
				sections.push(`<b>Рекомендуемые (${topLines.length}):</b>\n\n${topLines.join("\n\n")}`)
			}
			if (weakLines.length > 0) {
				sections.push(`<b>Слабые каналы (${weakLines.length}):</b>\n\n${weakLines.join("\n\n")}`)
			}

			const noDataNote = noDataChannels.length > 0 ? `\n\n⚠️ Нет постов по: ${noDataChannels.map((c) => "@" + c).join(", ")}` : ""

			// Summary-строка с распределением
			const summaryLine = `🟢 ${keepChannels.length} | 🟡 ${reviewChannels.length} | 🔴 ${muteChannels.length}`

			// Легенда метрик
			const metricsLegend = "\n\n<i>Метрики: Q=Качество контента, R=Релевантность профилю, S=Чистота от спама</i>"

			const fullText = `📋 Аудит каналов: ${scores.length} каналов\n${summaryLine}\n\n` + sections.join("\n\n") + noDataNote + metricsLegend
			const safeText = fullText.length > 4096 ? fullText.slice(0, 4093) + "…" : fullText

			// Кнопки действий
			const actionButtons = []

			// Индивидуальные кнопки для слабых каналов (до 10)
			const weakChannelButtons = muteChannels.slice(0, 10).map((s) => ({
				text: `🗑 @${s.channel}`,
				callback_data: `audit_remove_one:${s.channel}`
			}))

			// Группируем по 2 в ряд
			for (let i = 0; i < weakChannelButtons.length; i += 2) {
				actionButtons.push(weakChannelButtons.slice(i, i + 2))
			}

			// Общая кнопка удаления всех слабых
			if (muteChannels.length > 0) {
				actionButtons.push([{ text: `🗑 Удалить все слабые (${muteChannels.length})`, callback_data: "audit_remove_weak" }])
			}
			if (scores.length > topLimit) {
				actionButtons.push([{ text: "📊 Полный отчёт", callback_data: "audit_full_report" }])
			}
			// Кнопка оптимизации (Stage 4)
			if (muteChannels.length >= 3) {
				const avgScoreAfter = (scores.filter(s => s.verdict !== "mute").reduce((sum, s) => sum + s.score, 0) / Math.max(1, scores.filter(s => s.verdict !== "mute").length)).toFixed(1)
				actionButtons.push([{ text: `⚡ Оптимизировать (${muteChannels.length} → ${avgScoreAfter})`, callback_data: "audit_optimize" }])
			}
			const keyboard = actionButtons.length > 0 ? { reply_markup: { inline_keyboard: actionButtons } } : {}

			this.mgr.cache.setAuditWeak(userId, muteChannels.map((s) => s.channel))
			this.mgr.cache.setAuditScores(userId, scores) // Для полного отчёта
			await status.replace(safeText, { parse_mode: "HTML", disable_web_page_preview: true, ...keyboard })
		} catch (e) {
			await status.replace(`<b>❌ Ошибка анализа</b>\n\n${this.formatErrorForChat(e)}`, { parse_mode: "HTML" })
		}
	}
	async handleSummary(ctx) {
		await ctx.reply("📅 <b>Выберите дату для дайджеста:</b>", { parse_mode: "HTML", reply_markup: KeyboardProvider.summaryDate().reply_markup })
	}

	async handleChannels(ctx) {
		const channels = getChannels()
		if (channels.length === 0) {
			return ctx.reply("📢 <b>Каналы:</b>\n\nСписок пуст. Добавьте каналы через <code>/add @channel</code>", { parse_mode: "HTML", reply_markup: KeyboardProvider.channels().reply_markup })
		}
		const channelList = channels.map((ch, i) => `${i + 1}. @${ch.username}`).join("\n")
		await ctx.reply(`📢 <b>Каналы (${channels.length}):</b>\n\n${channelList}`, { parse_mode: "HTML", reply_markup: KeyboardProvider.channels().reply_markup })
	}

	async handleProfile(ctx) {
		const userId = ctx.from?.id
		const user = getOrCreateUser(userId)
		const profile = user.profile || "Не установлен"
		await ctx.reply(`👤 <b>Ваш профиль:</b>\n\n${profile}`, { parse_mode: "HTML", reply_markup: KeyboardProvider.profile().reply_markup })
	}

	async handleSettings(ctx) {
		const userId = ctx.from?.id
		const user = getOrCreateUser(userId)
		const text = "⚙️ <b>Настройки:</b>\n\n" +
			`<b>Интересы:</b> ${user.profile || "Не установлены"}\n` +
			`<b>Размер дайджеста:</b> ${user.digest_max_items || 7}\n` +
			`<b>Формат:</b> ${user.digest_format || "full"}\n` +
			`<b>Минус-слова:</b> ${user.minus_keywords || "Нет"}`
		await ctx.reply(text, { parse_mode: "HTML", reply_markup: KeyboardProvider.settings().reply_markup })
	}

	async handleBack(ctx) {
		await ctx.reply("🏠 Главное меню:", { parse_mode: "HTML", reply_markup: KeyboardProvider.mainReply().reply_markup })
	}

	async handleFetchMenu(ctx) {
		const userId = ctx.from?.id
		if (!userId) return
		console.log("[handleFetchMenu] userId:", userId, "isAdmin:", this.mgr.handlers.admin.isAdmin(userId))
		if (!this.mgr.handlers.admin.isAdmin(userId)) {
			return ctx.reply("Только администратор может собирать посты.")
		}
		await ctx.reply("🔄 Выберите период для сбора постов:", {
			reply_markup: KeyboardProvider.fetchDays().reply_markup
		})
	}

	async handleFetch(ctx) {
		if (!this.mgr.handlers.admin.isAdmin(ctx.from?.id)) return

		const args = ctx.message?.text?.split(/\s+/) || []
		const daysArg = parseInt(args[1], 10)
		const days = daysArg && daysArg > 0 ? daysArg : 1

		const status = new StatusMessage(ctx)
		await status.start(`🔄 Сбор постов за ${days} д...\n\n0% (0/0 каналов)`)

		const nowTs = Math.floor(Date.now() / 1000)
		const sinceTs = nowTs - (days * 24 * 60 * 60)

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
		let resultText = "✅ Сбор завершён\n\n" +
			`📥 Собрано: ${collected} постов\n` +
			`⏱ Всего: ${elapsed}с`
		if (errors.length > 0) {
			resultText += `\n⚠️ Ошибки: ${errors.length}`
			resultText += `\n${errors.slice(0, 5).map(e => `• ${e}`).join("\n")}`
			if (errors.length > 5) resultText += `\n... и ещё ${errors.length - 5}`
		}
		if (perChannel.length > 0) {
			resultText += "\n\nПо каналам:\n" +
				perChannel.map(c => `• @${c.channel}: ${c.count}`).join("\n")
		}

		await status.replace(resultText)
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

