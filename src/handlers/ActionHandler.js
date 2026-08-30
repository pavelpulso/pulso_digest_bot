import { BaseHandler } from "./BaseHandler.js"
import { VIDEO_TAIL_COUNT } from "../services/BotService.js"
import { KeyboardProvider } from "../ui/KeyboardProvider.js"
import { UIFormatter } from "../ui/UIFormatter.js"
import { StatusMessage } from "../services/StatusMessage.js"
import { getUserSystemPrompt } from "../services/SystemPromptLoader.js"
import {
	getOrCreateUser,
	isUserBanned,
	getChannels,
	upsertPostFeedback,
	setUserChannelHidden,
	getPostsForCalendarDay,
	removeChannelsByUsernames,
	removeChannel,
	addChannel,
	hasChannel,
	setUserDigestPause,
	clearUserDigestPause,
	setUserDigestPauseWeekends,
	upsertDigestFeedback,
	getRankingByUserAndPostLatest,
	markVideoWatched
} from "../db.js"
import { formatDateLabel, formatChannelList } from "../utils.js"
import { collectChannelPosts, fetchRecentPostsFromChannel } from "../gramjs.js"


export class ActionHandler extends BaseHandler {
	async handleMore(ctx) {
		const offset = parseInt(ctx.match[1], 10)
		const count = parseInt(ctx.match[2], 10)
		const userId = ctx.from?.id
		console.log("[handleMore] userId:", userId, "offset:", offset, "count:", count)
		if (!userId || isUserBanned(userId)) return
		await this.safeAnswerCbQuery(ctx, "Loading…")
		return this.mgr.service.digestReply(ctx, offset, count)
	}

	async handleFiltered(ctx) {
		const limit = parseInt(ctx.match[1], 10)
		const userId = ctx.from?.id
		console.log("[handleFiltered] userId:", userId, "limit:", limit)
		if (!userId || isUserBanned(userId)) return
		await this.safeAnswerCbQuery(ctx, "Loading filtered posts…")
		return this.mgr.service.showFilteredPosts(ctx, limit)
	}

	async handleWhy(ctx) {
		const postId = ctx.match[1]
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const cached = this.mgr.cache.getBlock(postId)
		if (!cached) {
			const r = getRankingByUserAndPostLatest(userId, postId)
			if (!r?.reason) return this.safeAnswerCbQuery(ctx, "Explanation unavailable")
			await this.safeAnswerCbQuery(ctx)
			return ctx.reply(`📌 <b>Why in digest:</b>\n\n${UIFormatter.escapeHtml(r.reason)}`, { parse_mode: "HTML" })
		}

		await this.safeAnswerCbQuery(ctx)
		const { block, postById, reason } = cached
		const fullText = cached.isVideo
			? cached.normalText
			: UIFormatter.formatBlockText(block, postById, { compact: false })
		const expanded = fullText + (reason ? `\n\n📌 <b>Why in digest:</b>\n${UIFormatter.escapeHtml(reason)}` : "")

		// Get channel and hidden status
		const channel = postById[postId]?.channel || null
		const isHidden = channel ? this.mgr.service.isUserChannelHidden(userId, channel) : false

		try {
			await ctx.editMessageText(expanded, {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...KeyboardProvider.blockKeyboard(postId, false, true, channel, isHidden)
			})
		} catch { /* Ignore */ }
	}

	async handleWhyCollapse(ctx) {
		const postId = ctx.match[1]
		const cached = this.mgr.cache.getBlock(postId)
		if (!cached) return this.safeAnswerCbQuery(ctx, "Cannot collapse")

		await this.safeAnswerCbQuery(ctx)

		// Get channel and hidden status
		const userId = ctx.from?.id
		const channel = cached.postById[postId]?.channel || null
		const isHidden = channel && userId ? this.mgr.service.isUserChannelHidden(userId, channel) : false

		try {
			await ctx.editMessageText(cached.normalText, {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...KeyboardProvider.blockKeyboard(postId, !!cached.reason, false, channel, isHidden)
			})
		} catch { /* Ignore */ }
	}

	async handleFeedback(ctx) {
		const postId = ctx.match[1]
		const rating = parseInt(ctx.match[2], 10)
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		upsertPostFeedback(userId, postId, rating)
		await this.safeAnswerCbQuery(ctx, "Thanks, noted")
	}

	async handleToggleHidden(ctx) {
		const channel = ctx.match[1]
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const isHidden = this.mgr.service.toggleUserChannelHidden(userId, channel)
		const actionText = isHidden ? "🙈 Hidden" : "👁 Shown"
		await this.safeAnswerCbQuery(ctx, `${actionText} @${channel}`)

		// Update message keyboard
		try {
			const msg = ctx.callbackQuery?.message
			const oldMarkup = msg?.reply_markup?.inline_keyboard || []
			const newRows = oldMarkup.map((row) => {
				return row.map((btn) => {
					if (btn.callback_data === `toggle_hidden:${channel}`) {
						return { ...btn, text: isHidden ? "👁 Show channel" : "🙈 Hide channel" }
					}
					return btn
				})
			})
			await ctx.editMessageReplyMarkup({ inline_keyboard: newRows })
		} catch { /* Ignore */ }
	}

	async handleDigest(ctx) {
		await this.safeAnswerCbQuery(ctx, "⏳ Building digest…")
		return this.mgr.handlers.command.handleDigest(ctx)
	}

	async handleSummary(ctx) {
		await this.safeAnswerCbQuery(ctx)
		await ctx.editMessageText("📅 <b>Select date for digest:</b>", { parse_mode: "HTML", reply_markup: KeyboardProvider.summaryDate().reply_markup })
	}

	async handleSummaryDay(ctx) {
		const dateStr = ctx.match[1]
		const userId = ctx.from?.id

		console.log("[handleSummaryDay] dateStr:", dateStr, "userId:", userId)

		if (!userId || isUserBanned(userId)) {
			console.log("[handleSummaryDay] user banned or missing")
			return this.safeAnswerCbQuery(ctx)
		}

		let status = null
		try {
			await this.safeAnswerCbQuery(ctx)

			status = new StatusMessage(ctx)
			await status.startProgress("⏳ <b>Preparing digest for selected date...</b>", 0)

			// Stage 1: Load posts (0-30%)
			await status.percent("⏳ <b>Loading posts...</b>", 15)
			const user = getOrCreateUser(userId)
			const date = dateStr
			const label = formatDateLabel(date)

			// Check for posts on selected date
			const posts = getPostsForCalendarDay(date)
			if (posts.length === 0) {
				// Fetch posts from channels for selected day
				await status.percent("⏳ <b>No posts — fetching from channels...</b>", 25)
				const sinceTs = Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000)
				const untilTs = sinceTs + 24 * 60 * 60
				await collectChannelPosts({
					sinceTs,
					untilTs,
					onProgress: async ({ channel, index, total, collected }) => {
						const pct = Math.round(25 + (index / total) * 40)
						const progressText = "⏳ <b>Fetching posts...</b>\n\n" +
							`${pct}% (${index}/${total} channels)\n` +
							`📥 Collected: ${collected} posts\n` +
							`📌 Now: @${channel}`
						await status.update(progressText)
					}
				})
				await status.percent("⏳ <b>Posts fetched...</b>", 65)
			}

			// Stage 2: Ranking (30-70%)
			await status.percent("⏳ <b>Ranking posts...</b>", 70)
			await this.mgr.service.ensureRankingsForDate(userId, date, user.profile || "")
			await status.percent("⏳ <b>Ranking posts...</b>", 80)

			// Stage 3: Block generation (80-100%)
			await status.percent("⏳ <b>Generating blocks...</b>", 90)
			await this.mgr.service.sendSummaryBlocks(ctx, date, label, 0, {
				messageToEdit: ctx.callbackQuery?.message?.message_id,
				status
			})

			// Complete (100%)
			await status.replace("✅ <b>Digest ready!</b>")
		} catch (e) {
			console.error("[handleSummaryDay] error:", e)
			const userMsg = this.formatErrorForChat(e)
			await status.replace("❌ <b>Failed to create digest</b>\n\n" + userMsg)
		}
	}

	async handleChannels(ctx) {
		await this.safeAnswerCbQuery(ctx, "⏳ Loading channels…")
		const channels = getChannels()
		await ctx.editMessageText(formatChannelList(channels), { ...KeyboardProvider.channels(), parse_mode: "HTML" })
	}

	async handleProfile(ctx) {
		await this.safeAnswerCbQuery(ctx, "⏳ Loading profile…")
		const userId = ctx.from?.id
		const user = getOrCreateUser(userId)
		await ctx.editMessageText(this.mgr.service.renderProfileText(userId, user), { ...KeyboardProvider.profile(), parse_mode: "HTML" })
	}

	async handleAuditHide(ctx) {
		const channel = ctx.match[1]
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		setUserChannelHidden(userId, channel, true)
		await this.safeAnswerCbQuery(ctx, `🙈 @${channel} hidden`)

		try {
			const oldMarkup = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || []
			const newRows = oldMarkup
				.map((row) => row.filter((btn) => btn.callback_data !== `audit_hide:${channel}`))
				.filter((row) => row.length > 0)
			await ctx.editMessageReplyMarkup({ inline_keyboard: newRows })
		} catch { /* Ignore */ }
	}

	async handleAuditAll(ctx) {
		await this.safeAnswerCbQuery(ctx)
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return
		await ctx.telegram.sendMessage(ctx.chat.id, "/channel_audit — run this command for full audit.")
	}

	async handleAuditHideAll(ctx) {
		const userId = ctx.from?.id
		const weak = this.mgr.cache.getAuditWeak(userId) || []
		if (weak.length === 0) return this.safeAnswerCbQuery(ctx, "No data")

		for (const ch of weak) setUserChannelHidden(userId, ch, true)
		await this.safeAnswerCbQuery(ctx, `🔕 Hidden ${weak.length} channels`)
		this.mgr.cache.deleteAuditWeak(userId)
		try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }) } catch { /* Ignore */ }
	}

	async handleFetchDays(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)
		
		const days = parseInt(ctx.match[1], 10)
		await this.safeAnswerCbQuery(ctx)
		await ctx.editMessageText(`<b>🔄 Fetching posts for ${days} days...</b>`, { parse_mode: "HTML" })

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
				const progressText = `🔄 Fetching posts for ${days} days...\n\n` +
					`${pct}% (${index}/${total} channels)\n` +
					`📥 Collected: ${currentCollected} posts\n` +
					`⏱ Elapsed: ${elapsed}s\n` +
					`📌 Now: @${channel}`
				await status.update(progressText)
			}
		})

		const elapsed = Math.round((Date.now() - startTime) / 1000)
		let resultText = "✅ Fetch complete\n\n" +
			`📥 Collected: ${collected} posts\n` +
			`⏱ Total: ${elapsed}s`
		if (errors.length > 0) {
			resultText += `\n⚠️ Errors: ${errors.length}`
			resultText += `\n${errors.slice(0, 5).map(e => `• ${e}`).join("\n")}`
			if (errors.length > 5) resultText += `\n... and ${errors.length - 5} more`
		}
		if (perChannel.length > 0) {
			resultText += "\n\nBy channel:\n" +
				perChannel.map(c => `• @${c.channel}: ${c.count}`).join("\n")
		}

		await status.replace(resultText)
	}

	async handleRemoveWeakChannels(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const weakChannels = this.mgr.cache.getAuditWeak(userId)
		if (!weakChannels || weakChannels.length === 0) {
			return this.safeAnswerCbQuery(ctx, "No weak channels to remove")
		}

		await this.safeAnswerCbQuery(ctx, `🗑 Removing ${weakChannels.length} channels...`)

		const removed = removeChannelsByUsernames(weakChannels)
		this.mgr.cache.deleteAuditWeak(userId)

		try {
			await ctx.editMessageText(`<b>✅ Removed ${removed} weak channels</b>\n${weakChannels.slice(0, 10).map(c => `@${c}`).join("\n")}${weakChannels.length > 10 ? `\n... and ${weakChannels.length - 10} more` : ""}`, { parse_mode: "HTML" })
		} catch { /* Ignore */ }
	}

	async handleRemoveOneChannel(ctx) {
		const channel = ctx.match[1]
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		await this.safeAnswerCbQuery(ctx, `🗑 Removing @${channel}...`)

		const removed = removeChannel(channel)
		this.mgr.cache.deleteAuditWeak(userId)
		this.mgr.cache.deleteAuditScores(userId)

		try {
			await ctx.editMessageText(removed ? `<b>✅ Removed @${channel}</b>` : `<b>❌ Failed to remove @${channel}</b>`, { parse_mode: "HTML" })
		} catch { /* Ignore */ }
	}

	async handleFullReport(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const scores = this.mgr.cache.getAuditScores(userId)
		if (!scores || scores.length === 0) {
			return this.safeAnswerCbQuery(ctx, "No audit data")
		}

		await this.safeAnswerCbQuery(ctx)

		// Build full report with score breakdown
		const lines = scores.map((s, i) => {
			const emoji = { keep: "🟢", review: "🟡", mute: "🔴" }[s.verdict] || "⚪"
			const problemLabel = s.problemType && s.problemType !== "none" ? `| ${s.problemType}` : ""
			const recText = s.recommendation === "keep_if" && s.keepIfCondition ? `\n   ⚠️ Keep if: ${s.keepIfCondition}` : ""
			return `${i + 1}. ${emoji} @${s.channel} — ${s.score.toFixed(1)} ${problemLabel}\n   ${s.summary}\n   ${s.reason || "No explanation"}${recText}`
		})

		const reportText = `📊 <b>Full Report: ${scores.length} channels</b>\n\n` + lines.join("\n\n")
		const safeText = reportText.length > 4096 ? reportText.slice(0, 4093) + "…" : reportText

		try {
			await ctx.editMessageText(safeText, { parse_mode: "HTML", disable_web_page_preview: true })
		} catch {
			// If too long for one message — send as separate message
			await ctx.reply(safeText, { parse_mode: "HTML", disable_web_page_preview: true })
		}
	}

	async handleOptimize(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const scores = this.mgr.cache.getAuditScores(userId)
		if (!scores || scores.length === 0) {
			return this.safeAnswerCbQuery(ctx, "No audit data")
		}

		const muteChannels = scores.filter(s => s.verdict === "mute")
		const keepChannels = scores.filter(s => s.verdict !== "mute")

		if (muteChannels.length === 0) {
			return this.safeAnswerCbQuery(ctx, "No channels to remove")
		}

		await this.safeAnswerCbQuery(ctx)

		// Optimization preview
		const currentAvg = (scores.reduce((sum, s) => sum + s.score, 0) / scores.length).toFixed(1)
		const newAvg = (keepChannels.reduce((sum, s) => sum + s.score, 0) / Math.max(1, keepChannels.length)).toFixed(1)
		const timeSaved = muteChannels.length * 3 // ~3 min per channel per day

		const previewText = "⚡ <b>Feed Optimization</b>\n\n" +
			`<b>Current:</b> ${scores.length} channels, avg score: ${currentAvg}\n` +
			`<b>After:</b> ${keepChannels.length} channels, avg score: ${newAvg}\n\n` +
			`<b>Remove (${muteChannels.length}):</b>\n` +
			muteChannels.slice(0, 10).map(c => `@${c.channel}`).join("\n") +
			(muteChannels.length > 10 ? `\n... and ${muteChannels.length - 10} more` : "") +
			`\n\n<i>~${timeSaved} min/day saved</i>`

		const keyboard = {
			reply_markup: {
				inline_keyboard: [
					[
						{ text: "✅ Confirm removal", callback_data: "optimize_confirm" },
						{ text: "❌ Cancel", callback_data: "optimize_cancel" }
					]
				]
			}
		}

		try {
			await ctx.editMessageText(previewText, { parse_mode: "HTML", ...keyboard })
		} catch {
			await ctx.reply(previewText, { parse_mode: "HTML", ...keyboard })
		}
	}

	async handleOptimizeConfirm(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const scores = this.mgr.cache.getAuditScores(userId)
		if (!scores) return this.safeAnswerCbQuery(ctx, "No audit data")

		const muteChannels = scores.filter(s => s.verdict === "mute").map(s => s.channel)
		if (muteChannels.length === 0) {
			return this.safeAnswerCbQuery(ctx, "No channels to remove")
		}

		await this.safeAnswerCbQuery(ctx, `🗑 Removing ${muteChannels.length} channels...`)

		const removed = removeChannelsByUsernames(muteChannels)
		this.mgr.cache.deleteAuditScores(userId)
		this.mgr.cache.deleteAuditWeak(userId)

		const keepChannels = scores.filter(s => s.verdict !== "mute")
		const newAvg = (keepChannels.reduce((sum, s) => sum + s.score, 0) / Math.max(1, keepChannels.length)).toFixed(1)

		try {
			await ctx.editMessageText(`<b>✅ Optimization complete!</b>\n\nRemoved: ${removed} channels\nRemaining: ${keepChannels.length} channels\nAvg score: ${newAvg}`, { parse_mode: "HTML" })
		} catch {
			await ctx.reply(`<b>✅ Optimization complete!</b>\n\nRemoved: ${removed} channels\nRemaining: ${keepChannels.length} channels\nAvg score: ${newAvg}`, { parse_mode: "HTML" })
		}
	}

	async handleOptimizeCancel(ctx) {
		await this.safeAnswerCbQuery(ctx, "❌ Cancelled")
		try {
			await ctx.editMessageText("<b>❌ Optimization cancelled</b>", { parse_mode: "HTML" })
		} catch { /* Ignore */ }
	}

	async handleAnalyzeChannelClick(ctx) {
		const channelName = ctx.match[1]
		const userId = ctx.from?.id

		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		await this.safeAnswerCbQuery(ctx)

		// Call channel analysis command (it will show its own status)
		return this.mgr.handlers.command.handleAnalyzeChannel(ctx, channelName)
	}

	async handleChannelAdd(ctx) {
		const channelName = ctx.match[1]
		const userId = ctx.from?.id

		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		// Check if channel already added
		const isAlreadyAdded = hasChannel(channelName)
		if (isAlreadyAdded) {
			return this.safeAnswerCbQuery(ctx, `✅ @${channelName} already added`)
		}

		await this.safeAnswerCbQuery(ctx, `⏳ Adding @${channelName}...`)

		const result = addChannel(channelName, userId)

		// Update message keyboard
		try {
			const newKeyboard = KeyboardProvider.analyzeChannelResult(channelName, true)
			await ctx.editMessageReplyMarkup(newKeyboard.reply_markup)
		} catch {
			// Ignore error
		}

		if (result.ok) {
			await ctx.reply(`✅ Channel <b>@${UIFormatter.escapeHtml(channelName)}</b> added!`, { parse_mode: "HTML" })
		} else {
			await ctx.reply(`⚠️ Channel <b>@${UIFormatter.escapeHtml(channelName)}</b> already exists.`, { parse_mode: "HTML" })
		}
	}

	async handleChannelSkip(ctx) {
		const userId = ctx.from?.id

		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		await this.safeAnswerCbQuery(ctx)

		// Just hide buttons, keep message
		try {
			await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
		} catch {
			// Ignore error
		}
	}

	async handleAnalyzeChannelMenu(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		await this.safeAnswerCbQuery(ctx)

		const channels = getChannels()
		if (channels.length === 0) {
			return ctx.editMessageText(
				"🔍 <b>Channel Analysis:</b>\n\n" +
				"No channels to analyze. Add channels via <code>/add @channel</code>",
				{ parse_mode: "HTML" }
			)
		}

		const channelList = channels.map((ch, i) => `${i + 1}. @${ch.username}`).join("\n")
		await ctx.editMessageText(
			"🔍 <b>Channel Analysis:</b>\n\n" +
			`Select a channel to analyze:\n\n${channelList}\n\n` +
			"Or send channel name:\n<code>@username</code>",
			{ parse_mode: "HTML", reply_markup: KeyboardProvider.analyzeChannelList(channels).reply_markup }
		)
	}

	async handleAnalyzePost(ctx) {
		const channelName = ctx.match[1]
		const userId = ctx.from?.id

		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		await this.safeAnswerCbQuery(ctx)

		const status = new StatusMessage(ctx)
		await status.start(`🔍 <b>Analyzing @${channelName}...</b>`)

		try {
			const user = getOrCreateUser(userId)

			// Fetch ~20 posts from the channel
			await status.update(`⏳ <b>Fetching posts from @${channelName}...</b>`)
			const posts = await fetchRecentPostsFromChannel(channelName, 20)

			if (posts.length === 0) {
				return status.replace(
					`❌ Failed to get posts from channel <b>@${UIFormatter.escapeHtml(channelName)}</b>.\n\n` +
					"Channel may be private or deleted."
				)
			}

			const minWarning = posts.length < 5 ? `\n⚠️ <i>Limited data (${posts.length} posts) — approximate score.</i>` : ""

			const systemPrompt = await getUserSystemPrompt(user)
			const result = await this.mgr.ai.analyzeChannel(posts, channelName, user.profile || "", systemPrompt)

			const { emoji, label: vLabel } = UIFormatter.verdictLabel(result.verdict)
			const snPct = Math.round((result.signal_noise || 0) * 100)
			const args = result.arguments.map((a) => `• ${UIFormatter.escapeHtml(a)}`).join("\n")

			const isAdded = hasChannel(channelName)
			const subscribeBtnText = isAdded ? "✅ Already subscribed" : "✅ Subscribe"
			const subscribeDisabled = isAdded

			const text =
				`📊 <b>Channel analysis @${UIFormatter.escapeHtml(channelName)}</b> (${posts.length} posts)${minWarning}\n\n` +
				`⭐ <b>Score:</b> ${result.score.toFixed(1)}/10\n` +
				`📶 <b>Signal/Noise:</b> ${snPct}%\n` +
				`${emoji} <b>Verdict:</b> ${vLabel}\n\n` +
				`<i>${UIFormatter.escapeHtml(result.summary)}</i>\n\n` +
				(args ? `<b>Arguments:</b>\n${args}` : "")

			// Keyboard with Subscribe/Skip buttons
			const keyboard = {
				reply_markup: {
					inline_keyboard: [
						[
							{
								text: subscribeBtnText,
								callback_data: `channel_add:${channelName}`,
								disabled: subscribeDisabled
							},
							{
								text: "❌ Skip",
								callback_data: `channel_skip:${channelName}`
							}
						]
					]
				}
			}

			await status.replace(text, { disable_web_page_preview: true, ...keyboard })
		} catch (e) {
			await status.replace("❌ Failed to analyze channel: " + this.formatErrorForChat(e))
		}
	}

	async handlePauseAction(ctx) {
		const userId = ctx.from?.id
		if (!userId) return

		const action = ctx.match[1]

		if (action === "resume") {
			clearUserDigestPause(userId)
			await ctx.editMessageText("▶️ <b>Digest resumed</b>\n\nMorning digest will be delivered as usual.", {
				parse_mode: "HTML",
				reply_markup: { inline_keyboard: [[{ text: "⚙️ Settings", callback_data: "menu" }]] }
			})
		} else if (action === "3d") {
			const until = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
			setUserDigestPause(userId, until)
			await ctx.editMessageText(
				`⏸ <b>Paused for 3 days</b>\n\nUntil: ${until.toLocaleDateString()}\n\nUse /settings to resume earlier.`,
				{ parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⚙️ Settings", callback_data: "menu" }]] } }
			)
		} else if (action === "7d") {
			const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
			setUserDigestPause(userId, until)
			await ctx.editMessageText(
				`⏸ <b>Paused for 7 days</b>\n\nUntil: ${until.toLocaleDateString()}\n\nUse /settings to resume earlier.`,
				{ parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⚙️ Settings", callback_data: "menu" }]] } }
			)
		} else if (action.startsWith("weekend:")) {
			const enabled = action.split(":")[1] === "1"
			setUserDigestPauseWeekends(userId, enabled)
			const text = enabled ? "⏭ <b>Weekend skip enabled</b>\n\nNo digest on Sat/Sun." : "⏭ <b>Weekend skip disabled</b>\n\nDigest will be delivered every day."
			await ctx.editMessageText(text, {
				parse_mode: "HTML",
				reply_markup: {
					inline_keyboard: [
						[{ text: "⏸ Pause 3 days", callback_data: "pause_3d" }, { text: "⏸ Pause 7 days", callback_data: "pause_7d" }],
						[{ text: "⏭ Skip weekends", callback_data: `pause_weekend:${enabled ? 0 : 1}` }],
						[{ text: "❌ Cancel", callback_data: "menu" }]
					]
				}
			})
		}

		await this.safeAnswerCbQuery(ctx)
	}

	async handleDigestFeedback(ctx) {
		const userId = ctx.from?.id
		if (!userId) return

		const date = ctx.match[1]
		const rating = parseInt(ctx.match[2], 10) // 1 = useful, 0 = so-so, -1 = irrelevant

		upsertDigestFeedback(userId, date, rating)

		const labels = { 1: "👍 Useful", 0: "😐 So-so", "-1": "👎 Irrelevant" }
		await ctx.editMessageText(`✅ <b>Feedback saved:</b> ${labels[rating]}`, {
			parse_mode: "HTML",
			reply_markup: { inline_keyboard: [[{ text: "📰 Open digest", callback_data: "digest" }]] }
		})
		await this.safeAnswerCbQuery(ctx)
	}

	async handleStatsRefresh(ctx) {
		const userId = ctx.from?.id
		if (!userId) return

		await this.safeAnswerCbQuery(ctx)
		return this.mgr.handlers.command.handleStats(ctx)
	}

	async handleVideoMore(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)
		await this.safeAnswerCbQuery(ctx)

		// Снимаем клавиатуру ДО асинхронной работы: markDigestShown коммитится
		// только после AI-запроса, поэтому двойной тап успевает прочитать один
		// и тот же набор непоказанных видео и отправить хвост дважды.
		try {
			await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
		} catch {}

		const sent = await this.mgr.service.sendVideoSection(ctx.telegram, userId, {
			limit: VIDEO_TAIL_COUNT,
			withHeader: false
		})
		if (sent === 0) await ctx.reply("Больше видео за неделю нет.")
	}

	async handleVideoWatched(ctx) {
		const postId = ctx.match[1]
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return this.safeAnswerCbQuery(ctx)

		const marked = markVideoWatched(userId, postId)
		if (!marked) return this.safeAnswerCbQuery(ctx, "Не найдено")

		await this.safeAnswerCbQuery(ctx, "Отмечено")

		try {
			const text = ctx.callbackQuery?.message?.text || ""
			await ctx.editMessageText(`✅ ${text}`, { disable_web_page_preview: true })
		} catch { /* Ignore */ }
	}
}
