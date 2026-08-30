import { BaseHandler } from "./BaseHandler.js"
import { KeyboardProvider } from "../ui/KeyboardProvider.js"
import { UIFormatter } from "../ui/UIFormatter.js"
import { StatusMessage } from "../services/StatusMessage.js"
import { getUserSystemPrompt } from "../services/SystemPromptLoader.js"
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
	getPostsForCalendarDay,
	hasChannel,
	updateUserSystemPromptUrl,
	updateUserSystemPromptCached,
	clearUserSystemPrompt,
	setUserOnboardingCompleted,
	isUserOnboardingCompleted,
	isUserDigestPaused,
	getUserDigestPause,
	getUserDigestPauseWeekends,
	setUserDigestPause,
	getUserStatsSummary,
	getUserTopChannels,
	getLikedUnwatchedVideos,
	countLikedUnwatchedVideos
} from "../db.js"
import { collectChannelPosts, fetchRecentPostsFromChannel } from "../gramjs.js"
import { DIGEST_PAGE_SIZE } from "../utils.js"
import { getDigestDate } from "../utils.js"

const LIKED_VIDEOS_LIMIT = 10

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

		// Check if onboarding already completed
		if (isUserOnboardingCompleted(userId)) {
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

			return ctx.reply(text, KeyboardProvider.mainReply())
		}

		// Onboarding tour — 3 messages
		setUserOnboardingCompleted(userId, true)

		const step1 =
			"👋 <b>Welcome to Pulso Digest Bot!</b>\n\n" +
			"I'm your personal AI assistant for Telegram channels.\n\n" +
			"<b>What I do:</b>\n" +
			"• Collect posts from your tracked channels\n" +
			"• Rank them by relevance to YOU\n" +
			"• Build a concise digest with key insights\n\n" +
			"Result: 10-15 min to read instead of hours scrolling."

		const step2 =
			"⚙️ <b>How to set up:</b>\n\n" +
			"1️⃣ <b>Add channels</b> — send <code>/add @channel</code>\n" +
			"2️⃣ <b>Set interests</b> — tell me what you care about\n" +
			"3️⃣ <b>Get digest</b> — tap /digest or wait for morning delivery\n\n" +
			"💡 <i>Tip: Forward any post from a channel to me — I'll add it automatically.</i>"

		const step3 =
			"🎯 <b>Let's personalize your digest!</b>\n\n" +
			"Send me your interests in this format:\n\n" +
			"<code>context your interests</code>\n\n" +
			"Examples:\n" +
			"• <code>context Senior JS dev, interested in AI/agents, career growth</code>\n" +
			"• <code>context Product manager, SaaS, B2B, analytics</code>\n\n" +
			"Or skip and set up later via /profile"

		await ctx.reply(step1, { parse_mode: "HTML" })
		await new Promise(r => setTimeout(r, 800))
		await ctx.reply(step2, { parse_mode: "HTML" })
		await new Promise(r => setTimeout(r, 800))
		await ctx.reply(step3, { parse_mode: "HTML", reply_markup: KeyboardProvider.mainReply() })
	}

	async handleDigest(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return

		const status = new StatusMessage(ctx)
		await status.startProgress("⏳ <b>Starting digest preparation...</b>", 0)

		const user = getOrCreateUser(userId)
		const date = getDigestDate()

		// Stage 1: Data preparation (0-20%)
		await status.percent("⏳ <b>Preparing data...</b>", 10)

		// Check for posts for digest date
		let posts = getPostsForCalendarDay(date)
		const channels = getChannelUsernames()

		console.log(`[handleDigest] userId=${userId} date=${date} channels=${channels.length} posts=${posts.length}`)

		// Always fetch if no channels or no posts
		if (channels.length === 0) {
			await status.percent("❌ <b>No channels configured</b>\n\nAdd channels via:\n• /add @channel\n• Forward a post from a channel", 100)
			return
		}

		// If no posts or too few (< 5) — fetch from last 48h to ensure we cover the digest period
		if (posts.length < 5) {
			await status.percent("⏳ <b>Not enough posts — fetching from channels...</b>\n\n📌 Channels: " + channels.map(c => `@${c}`).slice(0, 10).join(", ") + (channels.length > 10 ? `... +${channels.length - 10} more` : ""), 15)
			// Fetch posts from 72 hours ago to ensure we cover the full digest period (06:00 MSK yesterday to now)
			// Using 72h instead of 48h to account for timezone differences and ensure we don't miss posts
			const nowTs = Math.floor(Date.now() / 1000)
			const sinceTs = nowTs - 72 * 60 * 60
			try {
				const result = await collectChannelPosts({
					sinceTs,
					untilTs: nowTs,
					onProgress: async ({ channel, index, total, collected }) => {
						const pct = Math.round(15 + (index / total) * 50)
						const progressText = "⏳ <b>Fetching posts...</b>\n\n" +
							`${pct}% (${index}/${total} channels)\n` +
							`📥 Collected: ${collected} posts\n` +
							`📌 Now: @${channel}`
						await status.update(progressText)
					}
				})
				console.log(`[handleDigest] Fetch result: collected=${result.collected} errors=${result.errors.length}`)
				if (result.errors.length > 0) {
					console.error(`[handleDigest] Errors: ${result.errors.slice(0, 5).join(", ")}`)
				}
			} catch (e) {
				console.error(`[handleDigest] Fetch error:`, e)
				await status.replace("❌ <b>Failed to fetch posts</b>\n\n" + e.message)
				return
			}
			// Re-fetch posts for the digest date
			posts = getPostsForCalendarDay(date)
			console.log(`[handleDigest] After fetch: posts=${posts.length}`)
			await status.percent(`⏳ <b>Posts fetched... ${posts.length} posts for ${date}</b>`, 65)
		}

		// If still no posts after fetch
		if (posts.length === 0) {
			await status.replace("❌ <b>No posts found</b>\n\n" +
				`Checked ${channels.length} channels for ${date}\n\n` +
				"Possible reasons:\n" +
				"• Channels are private\n" +
				"• No new posts in last 48h\n" +
				"• TG_API_ID/HASH invalid\n\n" +
				"Try /fetch 1 to debug")
			return
		}

		const hasRankings = this.mgr.service.hasRankings(userId, date)

		if (!hasRankings) {
			// Stage 2: Post ranking (20-80%)
			await status.percent("⏳ <b>Ranking posts...</b>", 70)
			try {
				await this.mgr.service.ensureRankings(userId, user.profile || "")
				await status.percent("⏳ <b>Ranking posts...</b>", 80)
			} catch (e) {
				console.error(`[handleDigest] Rankings error:`, e)
				const userMsg = this.formatErrorForChat(e)
				await status.replace("❌ <b>Failed to get rankings</b>\n\n" + userMsg)
				return
			}
		} else {
			await status.percent("⏳ <b>Ranking posts...</b>", 80)
		}

		// Stage 3: Block generation (80-100%)
		await status.percent("⏳ <b>Generating digest blocks...</b>", 90)
		return this.mgr.service.digestReply(ctx, 0, DIGEST_PAGE_SIZE, status)
	}

	async handleAnalyzeChannel(ctx, channelName) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return

		// If channelName not provided — get from command
		if (!channelName) {
			const arg = (ctx.message?.text || "").replace(/^\/analyze_channel\s*/i, "").trim()
			channelName = arg.replace(/^@/, "").toLowerCase()
		} else {
			channelName = channelName.toLowerCase()
		}

		if (!channelName) {
			return ctx.reply(
				"Specify channel: <code>/analyze_channel @channel</code>\n" +
				"Example: <code>/analyze_channel durov</code>",
				{ parse_mode: "HTML" }
			)
		}

		const status = new StatusMessage(ctx)
		await status.start(`🔍 Analyzing @${channelName}...`)

		const user = getOrCreateUser(userId)
		const isAdded = hasChannel(channelName)

		try {
			// Try to get posts from DB
			let posts = getRecentPostsByChannel(channelName, 20)

			// If no posts — fetch via GramJS
			if (posts.length === 0) {
				await status.update(`⏳ <b>Fetching posts from @${channelName}...</b>`)
				posts = await fetchRecentPostsFromChannel(channelName, 20)
			}

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

			const text =
				`📊 <b>Channel analysis @${UIFormatter.escapeHtml(channelName)}</b> (${posts.length} posts)${minWarning}\n\n` +
				`⭐ <b>Score:</b> ${result.score.toFixed(1)}/10\n` +
				`📶 <b>Signal/Noise:</b> ${snPct}%\n` +
				`${emoji} <b>Verdict:</b> ${vLabel}\n\n` +
				`<i>${UIFormatter.escapeHtml(result.summary)}</i>\n\n` +
				(args ? `<b>Arguments:</b>\n${args}` : "")

			const keyboard = KeyboardProvider.analyzeChannelResult(channelName, isAdded)

			await status.replace(text, { disable_web_page_preview: true, ...keyboard })
		} catch (e) {
			await status.replace("❌ Failed to analyze channel: " + this.formatErrorForChat(e))
		}
	}

	async handleCmdAnalyzeChannel(ctx) {
		const channels = getChannels()
		if (channels.length === 0) {
			return ctx.reply(
				"🔍 <b>Channel Analysis:</b>\n\n" +
				"No channels to analyze. Add channels via <code>/add @channel</code>",
				{ parse_mode: "HTML" }
			)
		}

		const channelList = channels.map((ch, i) => `${i + 1}. @${ch.username}`).join("\n")
		await ctx.reply(
			"🔍 <b>Channel Analysis:</b>\n\n" +
			`Select a channel to analyze:\n\n${channelList}\n\n` +
			"Or send channel name:\n<code>@username</code>",
			{ parse_mode: "HTML", reply_markup: KeyboardProvider.analyzeChannelList(channels).reply_markup }
		)
	}

	async handleChannelAudit(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return

		const channels = getChannelUsernames()
		if (channels.length === 0) return ctx.reply("No channels.")

		const status = new StatusMessage(ctx)
		await status.start(`<b>📊 Channel Audit</b>\n\n⏳ Collecting posts from ${channels.length} channels...`)

		// Collect recent posts for each channel (ensure at least 15 posts)
		const channelsData = []
		let collectedTotal = 0

		for (const ch of channels) {
			let posts = getRecentPostsByChannel(ch, 15)
			
			// If less than 15 posts, fetch from Telegram
			if (posts.length < 15) {
				try {
					await status.update(`📥 Fetching posts from @${ch}... (${channelsData.length + 1}/${channels.length})`)
					const fetched = await fetchRecentPostsFromChannel(ch, 15 - posts.length)
					collectedTotal += fetched.length
					// Append fetched posts to existing posts
					posts = [...posts, ...fetched].slice(0, 15)
				} catch (e) {
					console.warn(`[audit] Failed to fetch from @${ch}:`, e.message)
					// Reload from DB to get whatever we have
					posts = getRecentPostsByChannel(ch, 15)
				}
			}
			
			// Calculate posting frequency
			let frequency = "unknown"
			if (posts.length >= 2) {
				const dates = posts.map(p => new Date(p.date).getTime()).sort((a, b) => b - a)
				const oldest = dates[dates.length - 1]
				const newest = dates[0]
				const daysSpan = Math.max(1, (newest - oldest) / (1000 * 60 * 60 * 24))
				const postsPerWeek = (posts.length / daysSpan) * 7
				
				if (postsPerWeek >= 5) frequency = "daily"
				else if (postsPerWeek >= 2) frequency = "several_times_week"
				else if (postsPerWeek >= 0.5) frequency = "weekly"
				else frequency = "rare"
			}
			
			channelsData.push({
				channel: ch.toLowerCase(),
				posts,
				postCount: posts.length,
				frequency
			})
		}

		const channelsWithData = channelsData.filter((cd) => cd.posts.length > 0)
		const noDataChannels = channelsData.filter((cd) => cd.posts.length === 0).map((cd) => cd.channel)

		console.log(`[audit] Channels: ${channels.length}, With data: ${channelsWithData.length}, No data: ${noDataChannels.length}`)
		channelsWithData.forEach(cd => console.log(`  @${cd.channel}: ${cd.posts.length} posts, ${cd.frequency}`))

		if (channelsWithData.length === 0) {
			return status.replace("❌ No data for any channel.")
		}

		const batchCount = Math.ceil(channelsWithData.length / 7)
		await status.percent(
			`<b>📊 Channel Audit</b>\n\n⏳ Analyzing ${channelsWithData.length} channels (${batchCount} batches of 7)...`,
			0,
			`Collected: ${collectedTotal} new posts`
		)

		const user = getOrCreateUser(userId)
		const systemPrompt = await getUserSystemPrompt(user)
		try {
			const scores = await this.mgr.ai.auditAllChannels(channelsWithData, user.profile || "", {
				onProgress: ({ analyzedChannels, totalChannels, percent, completedBatches, totalBatches }) => {
					status.percent(
						"⏳ Analyzing channels...",
						percent,
						`${analyzedChannels}/${totalChannels} channels — ${completedBatches}/${totalBatches} batches`
					)
				},
				systemPrompt
			})

			const scored = new Set(scores.map((s) => s.channel))
			for (const ch of channelsWithData.map((c) => c.channel)) {
				if (!scored.has(ch)) scores.push({
					channel: ch,
					score: 0,
					verdict: "mute",
					summary: "No data",
					reason: "Failed to get posts",
					problemType: "none",
					scoreBreakdown: { quality: 0, relevance: 0, spamFree: 1 },
					recommendation: "remove",
					keepIfCondition: ""
				})
			}
			scores.sort((a, b) => b.score - a.score)

			// Group by verdict
			const keepChannels = scores.filter((s) => s.verdict === "keep")
			const reviewChannels = scores.filter((s) => s.verdict === "review")
			const muteChannels = scores.filter((s) => s.verdict === "mute")

			// Format channel line
			const formatChannel = (s) => {
				const postCount = channelsData.find((cd) => cd.channel === s.channel)?.postCount || 0
				const postsLabel = postCount === 1 ? "post" : postCount < 5 ? "posts" : "posts"
				const avgViews = s.avgViews && isFinite(s.avgViews) ? (s.avgViews >= 1000 ? `${(s.avgViews / 1000).toFixed(1)}K` : Math.round(s.avgViews)) : "—"
				return `@${s.channel} — ${s.score.toFixed(1)} | 👁 ${avgViews} (${postCount} ${postsLabel})\n   ${s.summary}`
			}

			// Format weak channel with expanded reason
			const formatWeakChannel = (s) => {
				const problemLabel = {
					spam: "Spam",
					irrelevant: "Irrelevant to profile",
					low_quality: "Low quality",
					promo: "Promo/ads",
					outdated: "Outdated content",
					low_frequency: "Too infrequent",
					duplicate: "Duplicates other channels",
					noise: "Too much noise/flood",
					too_basic: "Too basic level",
					none: "Low value"
				}[s.problemType] || "Low value"

				return `🔴 @${s.channel} — ${s.score.toFixed(1)}\n   Problem: ${problemLabel}\n   ${s.reason}`
			}

			// Dynamic top-N limit
			const totalChannels = scores.length
			const topLimit = totalChannels <= 10 ? 10 : (totalChannels <= 20 ? 8 : 5)
			const topChannels = [...keepChannels, ...reviewChannels].slice(0, topLimit)
			const topLines = topChannels.map((s) => {
				const emoji = s.verdict === "keep" ? "🟢" : "🟡"
				return `${emoji} ${formatChannel(s)}`
			})

			// Weak channels with expanded reason
			const weakLines = muteChannels.map((s) => formatWeakChannel(s))

			// Build message sections
			const sections = []
			if (topLines.length > 0) {
				sections.push(`<b>Recommended (${topLines.length}):</b>\n\n${topLines.join("\n\n")}`)
			}
			if (weakLines.length > 0) {
				sections.push(`<b>Weak channels (${weakLines.length}):</b>\n\n${weakLines.join("\n\n")}`)
			}

			const noDataNote = noDataChannels.length > 0 ? `\n\n⚠️ No posts for: ${noDataChannels.map((c) => "@" + c).join(", ")}` : ""

			// Summary line with distribution
			const summaryLine = `🟢 ${keepChannels.length} | 🟡 ${reviewChannels.length} | 🔴 ${muteChannels.length}`

			const fullText = `📋 Channel Audit: ${scores.length} channels\n${summaryLine}\n\n` + sections.join("\n\n") + noDataNote
			const safeText = fullText.length > 4096 ? fullText.slice(0, 4093) + "…" : fullText

			// Action buttons
			const actionButtons = []

			// Individual buttons for weak channels (up to 10)
			const weakChannelButtons = muteChannels.slice(0, 10).map((s) => ({
				text: `🗑 @${s.channel}`,
				callback_data: `audit_remove_one:${s.channel}`
			}))

			// Group 2 per row
			for (let i = 0; i < weakChannelButtons.length; i += 2) {
				actionButtons.push(weakChannelButtons.slice(i, i + 2))
			}

			// General remove all weak button
			if (muteChannels.length > 0) {
				actionButtons.push([{ text: `🗑 Remove all weak (${muteChannels.length})`, callback_data: "audit_remove_weak" }])
			}
			if (scores.length > topLimit) {
				actionButtons.push([{ text: "📊 Full report", callback_data: "audit_full_report" }])
			}
			// Optimization button (Stage 4)
			if (muteChannels.length >= 3) {
				const avgScoreAfter = (scores.filter(s => s.verdict !== "mute").reduce((sum, s) => sum + s.score, 0) / Math.max(1, scores.filter(s => s.verdict !== "mute").length)).toFixed(1)
				actionButtons.push([{ text: `⚡ Optimize (${muteChannels.length} → ${avgScoreAfter})`, callback_data: "audit_optimize" }])
			}
			const keyboard = actionButtons.length > 0 ? { reply_markup: { inline_keyboard: actionButtons } } : {}

			this.mgr.cache.setAuditWeak(userId, muteChannels.map((s) => s.channel))
			this.mgr.cache.setAuditScores(userId, scores) // For full report
			await status.replace(safeText, { parse_mode: "HTML", disable_web_page_preview: true, ...keyboard })
		} catch (e) {
			await status.replace(`<b>❌ Analysis error</b>\n\n${this.formatErrorForChat(e)}`, { parse_mode: "HTML" })
		}
	}
	async handleSummary(ctx) {
		await ctx.reply("📅 <b>Select date for digest:</b>", { parse_mode: "HTML", reply_markup: KeyboardProvider.summaryDate().reply_markup })
	}

	async handleChannels(ctx) {
		const channels = getChannels()
		if (channels.length === 0) {
			return ctx.reply("📢 <b>Channels:</b>\n\nList is empty. Add channels via <code>/add @channel</code>", { parse_mode: "HTML", reply_markup: KeyboardProvider.channels().reply_markup })
		}
		const channelList = channels.map((ch, i) => `${i + 1}. @${ch.username}`).join("\n")
		await ctx.reply(`📢 <b>Channels (${channels.length}):</b>\n\n${channelList}`, { parse_mode: "HTML", reply_markup: KeyboardProvider.channels().reply_markup })
	}

	/** Formats one /liked entry: emoji-free title line, then channel · duration · views, then the link. */
	formatLikedEntry(row) {
		const title = UIFormatter.escapeHtml(String(row.text || "").split("\n")[0].trim())
		const channel = UIFormatter.escapeHtml(String(row.channel || "").replace(/^yt:/, ""))
		const meta = [UIFormatter.formatDuration(row.duration_sec), UIFormatter.formatViews(row.views)].filter(Boolean).join(" · ")
		const safeUrl = String(row.link || "#").replace(/&/g, "&amp;")
		return `${title}\n\n<a href="${safeUrl}">▶ ${channel}</a>${meta ? " · " + meta : ""}`
	}

	async handleLiked(ctx) {
		const userId = ctx.from?.id
		if (!userId) return

		const total = countLikedUnwatchedVideos(userId)
		if (total === 0) {
			return ctx.reply("Отложенных видео нет — всё просмотрено.", { parse_mode: "HTML" })
		}

		const rows = getLikedUnwatchedVideos(userId, LIKED_VIDEOS_LIMIT)
		for (const row of rows) {
			await ctx.reply(this.formatLikedEntry(row), {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				reply_markup: { inline_keyboard: [[{ text: "✅ Посмотрел", callback_data: `watched:${row.id}` }]] }
			})
		}

		const remaining = total - rows.length
		if (remaining > 0) {
			await ctx.reply(`И ещё ${remaining} видео в очереди.`, { parse_mode: "HTML" })
		}
	}

	async handleProfile(ctx) {
		const userId = ctx.from?.id
		const user = getOrCreateUser(userId)
		const profile = user.profile || "Not set"
		const sysPromptUrl = user.system_prompt_url || "Not set"
		const sysPromptCached = user.system_prompt_cached ? "✅ Loaded" : "❌ Not loaded"
		const cachedAt = user.system_prompt_cached_at ? new Date(user.system_prompt_cached_at).toLocaleString() : "—"

		const text = `👤 <b>Your Profile:</b>

<b>Interests:</b>
${UIFormatter.escapeHtml(profile)}

<b>System Prompt:</b>
URL: ${UIFormatter.escapeHtml(sysPromptUrl)}
Status: ${sysPromptCached}
Loaded: ${cachedAt}

Use:
/sysprompt [URL] — set URL
/sysprompt reload — reload
/sysprompt clear — clear
/sysprompt show — show text`

		await ctx.reply(text, { parse_mode: "HTML", reply_markup: KeyboardProvider.profile().reply_markup })
	}

	async handleSettings(ctx) {
		const userId = ctx.from?.id
		const user = getOrCreateUser(userId)
		const text = "⚙️ <b>Settings:</b>\n\n" +
			`<b>Interests:</b> ${UIFormatter.escapeHtml(user.profile || "Not set")}\n` +
			`<b>Digest size:</b> ${user.digest_max_items || 7}\n` +
			`<b>Format:</b> ${user.digest_format || "full"}\n` +
			`<b>Minus keywords:</b> ${UIFormatter.escapeHtml(user.minus_keywords || "None")}`
		await ctx.reply(text, { parse_mode: "HTML", reply_markup: KeyboardProvider.settings().reply_markup })
	}

	async handleBack(ctx) {
		await ctx.reply("🏠 Main menu:", { parse_mode: "HTML", reply_markup: KeyboardProvider.mainReply().reply_markup })
	}

	async handleFetchMenu(ctx) {
		const userId = ctx.from?.id
		if (!userId) return
		console.log("[handleFetchMenu] userId:", userId, "isAdmin:", this.mgr.handlers.admin.isAdmin(userId))
		if (!this.mgr.handlers.admin.isAdmin(userId)) {
			return ctx.reply("Only administrator can fetch posts.")
		}
		await ctx.reply("🔄 Select period for post collection:", {
			reply_markup: KeyboardProvider.fetchDays().reply_markup
		})
	}

	async handleFetch(ctx) {
		const userId = ctx.from?.id
		if (!userId || isUserBanned(userId)) return

		const args = ctx.message?.text?.split(/\s+/) || []
		const daysArg = parseInt(args[1], 10)
		const days = daysArg && daysArg > 0 ? daysArg : 1

		const status = new StatusMessage(ctx)
		await status.start(`🔄 Fetching posts for ${days} days...\n\n0% (0/0 channels)`)

		const nowTs = Math.floor(Date.now() / 1000)
		const sinceTs = nowTs - (days * 24 * 60 * 60)

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

	async handleSysPrompt(ctx) {
		const userId = ctx.from?.id
		if (!userId) return

		const args = ctx.message?.text?.split(/\s+/) || []
		const subcommand = args[1]?.toLowerCase()

		if (!subcommand) {
			return ctx.reply("Usage:\n/sysprompt [URL] — set URL\n/sysprompt reload — reload\n/sysprompt clear — clear\n/sysprompt show — show text")
		}

		const user = getOrCreateUser(userId)

		if (subcommand === "clear") {
			clearUserSystemPrompt(userId)
			return ctx.reply("✅ System prompt cleared.")
		}

		if (subcommand === "reload") {
			if (!user.system_prompt_url) {
				return ctx.reply("❌ System prompt URL not set.")
			}
			const status = new StatusMessage(ctx)
			await status.start("⏳ Loading prompt from URL...")
			const { refreshUserSystemPrompt } = await import("../services/SystemPromptLoader.js")
			const result = await refreshUserSystemPrompt(user, updateUserSystemPromptCached)
			if (result.success) {
				await status.replace(`✅ Prompt updated!\n\nLength: ${result.prompt.length} chars.`)
			} else {
				await status.replace(`❌ Load error: ${result.error}`)
			}
			return
		}

		if (subcommand === "show") {
			if (!user.system_prompt_cached) {
				return ctx.reply("❌ Prompt not loaded.")
			}
			const preview = user.system_prompt_cached.slice(0, 1000)
			const more = user.system_prompt_cached.length > 1000 ? `\n\n... ${user.system_prompt_cached.length - 1000} more chars` : ""
			return ctx.reply(`<b>System Prompt:</b>\n\n${UIFormatter.escapeHtml(preview)}${more}`, { parse_mode: "HTML" })
		}

		// Set URL
		const url = args.slice(1).join(" ").trim()
		if (!url) {
			return ctx.reply("❌ Specify URL.")
		}

		const { validateSystemPromptUrl } = await import("../services/SystemPromptLoader.js")
		const validation = validateSystemPromptUrl(url)
		if (!validation.valid) {
			return ctx.reply(`❌ Error: ${validation.error}`)
		}

		updateUserSystemPromptUrl(userId, url)

		// Auto-load
		const status = new StatusMessage(ctx)
		await status.start("⏳ Loading prompt from URL...")
		const { refreshUserSystemPrompt } = await import("../services/SystemPromptLoader.js")
		const updatedUser = getOrCreateUser(userId)
		const result = await refreshUserSystemPrompt(updatedUser, updateUserSystemPromptCached)
		if (result.success) {
			await status.replace(`✅ URL set and prompt loaded!\n\nLength: ${result.prompt.length} chars.`)
		} else {
			await status.replace(`✅ URL set.\n⚠️ Load error: ${result.error}. Try /sysprompt reload later.`)
		}
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

	async handlePauseDigest(ctx) {
		const userId = ctx.from?.id
		if (!userId) return

		const isPaused = isUserDigestPaused(userId)
		const pauseUntil = getUserDigestPause(userId)
		const weekendsEnabled = getUserDigestPauseWeekends(userId)

		if (isPaused) {
			const untilDate = new Date(pauseUntil).toLocaleDateString()
			return ctx.reply(
				`⏸ <b>Digest is paused</b>\n\n` +
				`Until: ${untilDate}\n\n` +
				"Select option:",
				{
					parse_mode: "HTML",
					reply_markup: {
						inline_keyboard: [
							[{ text: "▶️ Resume now", callback_data: "pause_resume" }],
							[{ text: "⏭ Skip weekends", callback_data: `pause_weekend:${weekendsEnabled ? 0 : 1}` }],
							[{ text: "⏸ Pause 3 days", callback_data: "pause_3d" }, { text: "⏸ Pause 7 days", callback_data: "pause_7d" }],
							[{ text: "❌ Cancel", callback_data: "menu" }]
						]
					}
				}
			)
		}

		return ctx.reply(
			"⏸ <b>Pause morning digest</b>\n\n" +
			"Select option:",
			{
				parse_mode: "HTML",
				reply_markup: {
					inline_keyboard: [
						[{ text: "⏸ Pause 3 days", callback_data: "pause_3d" }, { text: "⏸ Pause 7 days", callback_data: "pause_7d" }],
						[{ text: "⏭ Skip weekends", callback_data: `pause_weekend:${weekendsEnabled ? 0 : 1}` }],
						[{ text: "❌ Cancel", callback_data: "menu" }]
					]
				}
			}
		)
	}

	async handleStats(ctx) {
		const userId = ctx.from?.id
		if (!userId) return

		const stats = getUserStatsSummary(userId, 7)
		const topChannels = getUserTopChannels(userId, 3)

		const topChannelsText = topChannels.length > 0
			? topChannels.map((c, i) => `${i + 1}. @${c.channel} — ${c.count} liked posts`).join("\n")
			: "No data yet"

		const text =
			"📊 <b>Your stats (last 7 days)</b>\n\n" +
			`📰 Digests opened: ${stats.digestsOpened}\n` +
			`📝 Posts read: ${stats.postsRead}\n\n` +
			`<b>Top channels:</b>\n${topChannelsText}`

		await ctx.reply(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "stats_refresh" }]] } })
	}
}

