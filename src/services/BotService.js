import { v4 as uuidv4 } from "uuid"
import {
	getRankedPostIds,
	clearRankingsForUser,
	insertRankings,
	getRankedPostIdsAboveScore,
	getPostsByIds,
	getOrCreateUser,
	getRankingsMap,
	getRankingByUserAndPost,
	getDigestFormat,
	getUserChannelPriorities,
	getPostFeedbackForRanking,
	getUserHiddenChannels,
	getUserMinusKeywords,
	getPostsForDateRange,
	getRankedPostIdsWithTotal,
	getUsersForMorningDigest,
	getPostsForCalendarDay,
	toggleUserChannelHidden,
	getUserChannelSettings,
	getUser
} from "../db.js"
import { getUserSystemPrompt } from "./SystemPromptLoader.js"
import { formatDateLabel, MIN_DIGEST_SCORE, DIGEST_PAGE_SIZE } from "../utils.js"
import { UIFormatter } from "../ui/UIFormatter.js"
import { KeyboardProvider } from "../ui/KeyboardProvider.js"
import { collectChannelPosts } from "../gramjs.js"

export class BotService {
	constructor(botManager) {
		this.mgr = botManager
	}

	todayDate() {
		return new Date().toISOString().slice(0, 10)
	}

	hasRankings(userId, date) {
		return getRankedPostIds(userId, date, 1).length > 0
	}

	async ensureRankings(userId, userProfile) {
		const date = this.todayDate()
		if (this.hasRankings(userId, date)) return

		let allPosts = getPostsForCalendarDay(date)

		// If no posts — fetch last 24 hours
		if (allPosts.length === 0) {
			const nowTs = Math.floor(Date.now() / 1000)
			const sinceTs = nowTs - 24 * 60 * 60
			await collectChannelPosts({ sinceTs, untilTs: nowTs })
			allPosts = getPostsForCalendarDay(date)
		}

		const posts = this.filterPostsForUser(allPosts, userId)
		if (posts.length === 0) return

		const priorities = getUserChannelPriorities(userId)
		const feedback = getPostFeedbackForRanking(userId)
		const user = getUser(userId)
		const systemPrompt = await getUserSystemPrompt(user)

		const ranked = await this.mgr.ai.rankPosts(posts, userProfile, { channelPriorities: priorities, feedback, systemPrompt })
		clearRankingsForUser(userId, date)

		const items = ranked.map((r) => ({
			id: uuidv4(),
			post_id: r.post_id,
			score: r.score,
			reason: r.reason
		}))
		insertRankings(userId, date, items)
	}

	async ensureRankingsForDate(userId, date, userProfile) {
		if (this.hasRankings(userId, date)) return

		let allPosts = getPostsForCalendarDay(date)

		// If no posts — fetch for selected day
		if (allPosts.length === 0) {
			const sinceTs = Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000)
			const untilTs = sinceTs + 24 * 60 * 60
			await collectChannelPosts({ sinceTs, untilTs })
			allPosts = getPostsForCalendarDay(date)
		}

		const posts = this.filterPostsForUser(allPosts, userId)
		if (posts.length === 0) return

		const priorities = getUserChannelPriorities(userId)
		const feedback = getPostFeedbackForRanking(userId)
		const user = getUser(userId)
		const systemPrompt = await getUserSystemPrompt(user)

		const ranked = await this.mgr.ai.rankPosts(posts, userProfile, { channelPriorities: priorities, feedback, systemPrompt })
		clearRankingsForUser(userId, date)

		const items = ranked.map((r) => ({
			id: uuidv4(),
			post_id: r.post_id,
			score: r.score,
			reason: r.reason
		}))
		insertRankings(userId, date, items)
	}

	filterPostsForUser(posts, userId) {
		const hidden = new Set(getUserHiddenChannels(userId).map((c) => c.toLowerCase()))
		const minusKeywords = getUserMinusKeywords(userId)
		return posts.filter((p) => {
			if (hidden.has((p.channel || "").toLowerCase())) return false
			if (minusKeywords.length === 0) return true
			const t = (p.text || "").toLowerCase()
			return !minusKeywords.some((kw) => t.includes(kw))
		})
	}

	/** Checks if channel is hidden for user */
	isUserChannelHidden(userId, channel) {
		const settings = getUserChannelSettings(userId)
		return settings[channel]?.hidden || false
	}

	/** Toggles channel hidden status, returns new state */
	toggleUserChannelHidden(userId, channel) {
		return toggleUserChannelHidden(userId, channel)
	}

	getDigestPostIds(userId, date, limit, offset) {
		// Adaptive threshold: start with MIN_DIGEST_SCORE (0.5)
		let threshold = MIN_DIGEST_SCORE

		// Get all posts with score >= 0.5
		const idsAbove = getRankedPostIdsAboveScore(userId, date, threshold, 10000, 0)

		// If too many posts (> 1.5x limit), raise threshold to 0.65
		const maxItems = limit * 1.5
		if (idsAbove.length > maxItems) {
			threshold = 0.65
			const idsAboveHigher = getRankedPostIdsAboveScore(userId, date, threshold, 10000, 0)
			// If still too many, try 0.75
			if (idsAboveHigher.length > maxItems) {
				threshold = 0.75
				const idsAboveEvenHigher = getRankedPostIdsAboveScore(userId, date, threshold, 10000, 0)
				// If still too many, take top N
				if (idsAboveEvenHigher.length > maxItems) {
					const allIds = getRankedPostIds(userId, date, 10000, 0)
					allIds.sort((a, b) => {
						const rankA = getRankingByUserAndPost(userId, a, date)
						const rankB = getRankingByUserAndPost(userId, b, date)
						return (rankB?.score || 0) - (rankA?.score || 0)
					})
					return {
						postIds: allIds.slice(offset, offset + limit),
						total: allIds.length,
						threshold: 0.75
					}
				}
				return {
					postIds: idsAboveEvenHigher.slice(offset, offset + limit),
					total: idsAboveEvenHigher.length,
					threshold
				}
			}
			return {
				postIds: idsAboveHigher.slice(offset, offset + limit),
				total: idsAboveHigher.length,
				threshold
			}
		}

		// If too few posts (< 5), lower threshold to 0.4
		if (idsAbove.length < 5 && idsAbove.length > 0) {
			threshold = 0.4
			const idsAboveLower = getRankedPostIdsAboveScore(userId, date, threshold, 10000, 0)
			return {
				postIds: idsAboveLower.slice(offset, offset + limit),
				total: idsAboveLower.length,
				threshold
			}
		}

		// If no posts with score >= 0.5, take all
		const allIds = idsAbove.length === 0 ? getRankedPostIds(userId, date, 10000, 0) : idsAbove
		return {
			postIds: allIds.slice(offset, offset + limit),
			total: allIds.length,
			threshold
		}
	}

	async digestReply(ctx, offset = 0, count = DIGEST_PAGE_SIZE, status = null) {
		const userId = ctx.from?.id
		const date = this.todayDate()
		const { postIds, total } = this.getDigestPostIds(userId, date, count, offset)

		if (postIds.length === 0) {
			if (status) {
				await status.replace("❌ No posts for digest. Add channels or wait for /fetch.")
			} else {
				await ctx.reply("No posts yet. Add channels or wait for /fetch.")
			}
			return
		}

		const posts = getPostsByIds(postIds)
		const orderMap = Object.fromEntries(postIds.map((id, i) => [id, i]))
		posts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

		const user = getOrCreateUser(userId)
		const label = formatDateLabel(date)
		const systemPrompt = await getUserSystemPrompt(user)

		// Update progress before generating blocks
		if (status) await status.percent("⏳ <b>Generating digest blocks...</b>", 95)

		const result = await this.mgr.ai.generateSummaryBlocks(posts, label, user.profile || "", user.digest_max_items, {
			onProgress: (pct) => {
				if (status) {
					const progress = 95 + Math.round(pct / 100 * 5)
					status.percent("⏳ <b>Generating digest blocks...</b>", progress)
				}
			},
			systemPrompt
		})

		const postById = UIFormatter.buildPostById(posts)
		const rankMap = getRankingsMap(userId, date)
		const compact = getDigestFormat(userId) === "compact"

		const header = UIFormatter.formatDigestHeader(label, result.teaser, result.blocks.length)
		const row = []
		if (offset + count < total) {
			row.push({ text: "▶️ More 5", callback_data: `more:${offset + count}:5` })
			row.push({ text: "▶️ More 10", callback_data: `more:${offset + count}:10` })
		}
		row.push({ text: "📋 Summary", callback_data: "summary" })

		// Replace status message with digest header (100%)
		if (status) {
			await status.replace(header, { reply_markup: { inline_keyboard: [row] }, disable_web_page_preview: true, parse_mode: "HTML" })
		} else {
			await ctx.telegram.sendMessage(ctx.chat.id, header, {
				parse_mode: "HTML",
				reply_markup: { inline_keyboard: [row] },
				disable_web_page_preview: true
			})
		}

		for (const block of result.blocks) {
			const postId = block.ids.length === 1 ? block.ids[0] : null
			const reason = postId ? rankMap[postId]?.reason : null
			const channel = postId && postById[postId] ? postById[postId].channel : null
			const blockText = UIFormatter.formatBlockText(block, postById, { compact })
			const kb = KeyboardProvider.blockKeyboard(postId, !!reason, false, channel)

			await ctx.telegram.sendMessage(ctx.chat.id, blockText, {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...kb
			})
			if (postId) this.mgr.cache.setBlock(postId, { normalText: blockText, block, postById, reason })
		}
	}

	getRanking(userId, postId) {
		return getRankingByUserAndPost(userId, postId, this.todayDate())
	}

	async ensureRankingsForUserAndPosts(userId, date, posts, userProfile) {
		const existing = getRankedPostIds(userId, date, 1)
		if (existing.length > 0) return posts.length
		if (posts.length === 0) return 0

		const priorities = getUserChannelPriorities(userId)
		const feedback = getPostFeedbackForRanking(userId)
		try {
			const ranked = await this.mgr.ai.rankPosts(posts, userProfile, { channelPriorities: priorities, feedback })
			clearRankingsForUser(userId, date)
			const items = ranked.map((r) => ({
				id: uuidv4(),
				post_id: r.post_id,
				score: r.score,
				reason: r.reason
			}))
			insertRankings(userId, date, items)
			return ranked.length
		} catch (e) {
			console.error("Gemini rank error:", e)
			throw e
		}
	}

	renderProfileText(userId, user) {
		const profile = user.profile || "Not set. Use /profile context... to set."
		const maxItems = user.digest_max_items || 7
		const format = user.digest_format || "full"
		const keywords = user.minus_keywords || "None"
		const sysPromptUrl = user.system_prompt_url || "Not set"
		const sysPromptCached = user.system_prompt_cached ? "✅ Loaded" : "❌ Not loaded"
		const cachedAt = user.system_prompt_cached_at ? new Date(user.system_prompt_cached_at).toLocaleString() : "—"

		return "👤 <b>Your Profile</b>\n\n" +
			`<b>Interests:</b>\n${UIFormatter.escapeHtml(profile)}\n\n` +
			`<b>System Prompt:</b>\nURL: ${sysPromptUrl}\nStatus: ${sysPromptCached}\nLoaded: ${cachedAt}\n\n` +
			`<b>Digest Size:</b> ${maxItems} items\n` +
			`<b>Format:</b> ${format}\n` +
			`<b>Minus keywords:</b> ${UIFormatter.escapeHtml(keywords)}\n\n` +
			"Use buttons to edit settings."
	}
	async sendSummaryBlocks(ctx, dateStr, label, offset = 0, options = {}) {
		const userId = ctx.from?.id
		const user = getOrCreateUser(userId)
		const maxItems = options.maxItems || (user.digest_max_items ?? 7)
		const chatId = options.chatId || ctx.chat?.id

		const since = `${dateStr}T00:00:00.000Z`
		const until = new Date(new Date(since).getTime() + 24 * 60 * 60 * 1000).toISOString()
		let posts = getPostsForDateRange(since, until)

		// Filter posts for user (hidden channels, minus-words)
		posts = this.filterPostsForUser(posts, userId)

		if (posts.length === 0) return ctx.telegram.sendMessage(chatId, "<b>No posts for selected day</b>", { parse_mode: "HTML" })

		// For summary we need ensureRankingsForUserAndPosts - I should check if it's available or move it
		// For now assume it will be in mgr.service or similar
		const { postIds, total } = getRankedPostIdsWithTotal(userId, dateStr, maxItems, offset, 0)

		const rankedPosts = getPostsByIds(postIds)
		const orderMap = Object.fromEntries(postIds.map((id, i) => [id, i]))
		rankedPosts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

		const systemPrompt = await getUserSystemPrompt(user)
		const result = await this.mgr.ai.generateSummaryBlocks(rankedPosts, label, user.profile || "", maxItems, {
			onProgress: (pct) => {
				if (options.status) {
					const progress = 70 + Math.round(pct / 100 * 30)
					options.status.percent("⏳ <b>Generating blocks...</b>", progress)
				}
			},
			systemPrompt
		})
		const postById = UIFormatter.buildPostById(rankedPosts)
		const rankMap = getRankingsMap(userId, dateStr)
		const compact = getDigestFormat(userId) === "compact"

		if (options.messageToEdit) await ctx.telegram.deleteMessage(chatId, options.messageToEdit).catch(() => { })

		const header = UIFormatter.formatDigestHeader(label, result.teaser, result.blocks.length)
		const hasMore = offset + maxItems < total
		const row = []
		if (hasMore) row.push({ text: `▶️ More ${maxItems}`, callback_data: `summary_more:${dateStr}:${offset + maxItems}:${maxItems}` })
		row.push({ text: "📋 Menu", callback_data: "menu" })

		await ctx.telegram.sendMessage(chatId, header, { 
			parse_mode: "HTML", 
			disable_web_page_preview: true,
			reply_markup: { inline_keyboard: [row] } 
		})
		for (const block of result.blocks) {
			const postId = block.ids.length === 1 ? block.ids[0] : null
			const reason = postId ? rankMap[postId]?.reason : null
			const channel = postId && postById[postId] ? postById[postId].channel : null
			const blockText = UIFormatter.formatBlockText(block, postById, { compact })
			const kb = KeyboardProvider.blockKeyboard(postId, !!reason, false, channel)
			await ctx.telegram.sendMessage(chatId, blockText, {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...kb
			})
			if (postId) this.mgr.cache.setBlock(postId, { normalText: blockText, block, postById, reason })
		}
	}

	async sendMorningDigests(botInstance) {
		const users = getUsersForMorningDigest()
		const yesterday = new Date()
		yesterday.setDate(yesterday.getDate() - 1)
		const yesterdayStr = yesterday.toISOString().slice(0, 10)

		for (const u of users) {
			try {
				await this.ensureRankingsForDate(u.user_id, yesterdayStr, u.profile || "")
				const payload = await this.buildDigestBlocksForDate(u.user_id, yesterdayStr)
				if (!payload) continue

				const teaserText = payload.teaser
					? `☀️ <b>Yesterday's highlights:</b> ${UIFormatter.escapeHtml(payload.teaser)}\n\n<i>Open digest — full breakdown below.</i>`
					: "☀️ <b>Yesterday's digest is ready</b>. Open below."

				await botInstance.telegram.sendMessage(u.user_id, teaserText, {
					parse_mode: "HTML",
					reply_markup: { inline_keyboard: [[{ text: "📰 Open digest", callback_data: "digest" }]] },
					disable_web_page_preview: true
				})

				await botInstance.telegram.sendMessage(u.user_id, payload.header, { parse_mode: "HTML", disable_web_page_preview: true })
				await botInstance.telegram.sendMessage(u.user_id, "<b>Top picks for you:</b>", { parse_mode: "HTML", disable_web_page_preview: true })

				const compact = getDigestFormat(u.user_id) === "compact"
				for (const block of payload.blocks) {
					const postId = block.ids.length === 1 ? block.ids[0] : null
					const reason = postId ? payload.rankMap[postId]?.reason : null
					const channel = postId && payload.postById[postId] ? payload.postById[postId].channel : null
					const blockText = UIFormatter.formatBlockText(block, payload.postById, { compact })
					const kb = KeyboardProvider.blockKeyboard(postId, !!reason, false, channel)
					await botInstance.telegram.sendMessage(u.user_id, blockText, {
						parse_mode: "HTML",
						disable_web_page_preview: true,
						...kb
					})
					if (postId) this.mgr.cache.setBlock(postId, { normalText: blockText, block, postById: payload.postById, reason })
				}
			} catch (e) {
				console.error("[morning digest] user", u.user_id, e)
			}
		}
	}

	async buildDigestBlocks(userId) {
		const date = this.todayDate()
		const { postIds } = this.getDigestPostIds(userId, date, DIGEST_PAGE_SIZE, 0)
		if (postIds.length === 0) return null

		const posts = getPostsByIds(postIds)
		const orderMap = Object.fromEntries(postIds.map((id, i) => [id, i]))
		posts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

		const user = getOrCreateUser(userId)
		const label = formatDateLabel(date)
		const systemPrompt = await getUserSystemPrompt(user)
		const result = await this.mgr.ai.generateSummaryBlocks(posts, label, user.profile || "", user.digest_max_items, { systemPrompt })
		if (!result.blocks?.length) return null

		return {
			header: UIFormatter.formatDigestHeader("morning", result.teaser, result.blocks.length, { morning: true }),
			teaser: result.teaser,
			blocks: result.blocks,
			postById: UIFormatter.buildPostById(posts),
			rankMap: getRankingsMap(userId, date)
		}
	}

	async buildDigestBlocksForDate(userId, date) {
		const { postIds } = this.getDigestPostIds(userId, date, DIGEST_PAGE_SIZE, 0)
		if (postIds.length === 0) return null

		const posts = getPostsByIds(postIds)
		const orderMap = Object.fromEntries(postIds.map((id, i) => [id, i]))
		posts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

		const user = getOrCreateUser(userId)
		const label = formatDateLabel(date)
		const systemPrompt = await getUserSystemPrompt(user)
		const result = await this.mgr.ai.generateSummaryBlocks(posts, label, user.profile || "", user.digest_max_items, { systemPrompt })
		if (!result.blocks?.length) return null

		return {
			header: UIFormatter.formatDigestHeader(label, result.teaser, result.blocks.length),
			teaser: result.teaser,
			blocks: result.blocks,
			postById: UIFormatter.buildPostById(posts),
			rankMap: getRankingsMap(userId, date)
		}
	}
}
