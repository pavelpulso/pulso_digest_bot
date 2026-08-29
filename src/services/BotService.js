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
	getUser,
	upsertUserStat,
	getShownPostIds,
	markDigestShown,
	getVideoCandidates,
	getChannelViewNorms
} from "../db.js"
import { getUserSystemPrompt } from "./SystemPromptLoader.js"
import { formatDateLabel, MIN_DIGEST_SCORE, DIGEST_PAGE_SIZE, getDigestDate } from "../utils.js"
import { UIFormatter } from "../ui/UIFormatter.js"
import { KeyboardProvider } from "../ui/KeyboardProvider.js"
import { collectChannelPosts } from "../gramjs.js"
import { computeBoost } from "../youtube/scoring.js"

const VIDEO_WINDOW_DAYS = 7
const VIDEO_LEAD_COUNT = 3
const VIDEO_DAILY_CAP = 10
const VIDEO_NORM_MIN_AGE_DAYS = 7
const VIDEO_NORM_MAX_AGE_DAYS = 90

export class BotService {
	constructor(botManager) {
		this.mgr = botManager
	}

	digestDate() {
		return getDigestDate()
	}

	/**
	 * Топ видео за скользящее окно. Показанные лежат в digest_shown, поэтому
	 * повторный вызов естественно отдаёт следующие — хвост нигде не хранится.
	 */
	async selectVideosForDigest(userId, { limit = VIDEO_LEAD_COUNT } = {}) {
		const shown = getShownPostIds(userId)
		const candidates = getVideoCandidates(VIDEO_WINDOW_DAYS, shown, userId)
		if (candidates.length === 0) return { videos: [], remaining: 0 }

		const user = getOrCreateUser(userId)
		const ranked = await this.mgr.ai.rankPosts(candidates, user.profile || "")
		const scoreById = new Map(ranked.map((r) => [String(r.post_id), Number(r.score) || 0]))
		const norms = getChannelViewNorms(VIDEO_NORM_MIN_AGE_DAYS, VIDEO_NORM_MAX_AGE_DAYS)

		const scored = candidates.map((v) => {
			const norm = norms.get(v.channel) || { medianViews: 0, maturedCount: 0 }
			const boost = computeBoost(v.views, norm.medianViews, norm.maturedCount)
			return { video: v, score: (scoreById.get(v.id) || 0) * (1 + boost) }
		}).sort((a, b) => b.score - a.score)

		const capped = scored.slice(0, VIDEO_DAILY_CAP)
		return {
			videos: capped.slice(0, limit).map((s) => s.video),
			remaining: Math.max(0, capped.length - limit)
		}
	}

	/**
	 * Видео-секция изолирована от текстовой: её падение не должно отменять дайджест,
	 * который уже собран и отправлен.
	 */
	async sendVideoSection(telegram, userId, { limit = VIDEO_LEAD_COUNT, withHeader = true } = {}) {
		let picked
		try {
			picked = await this.selectVideosForDigest(userId, { limit })
		} catch (e) {
			console.error("[video section] user", userId, e.message)
			return 0
		}

		if (picked.videos.length === 0) return 0

		const user = getOrCreateUser(userId)
		const label = formatDateLabel(new Date())
		let result
		try {
			result = await this.mgr.ai.generateSummaryBlocks(
				picked.videos, label, user.profile || "", picked.videos.length,
				{ compact: true }
			)
		} catch (e) {
			console.error("[video section] blocks failed for user", userId, e.message)
			return 0
		}

		if (!result.blocks?.length) return 0

		if (withHeader) {
			await telegram.sendMessage(userId, "📺 <b>Посмотреть</b>", { parse_mode: "HTML" })
		}

		const postById = UIFormatter.buildPostById(picked.videos)
		const shownIds = []

		for (const block of result.blocks) {
			const postId = block.ids.length === 1 ? block.ids[0] : null
			const text = UIFormatter.formatVideoBlockText(block, postById)
			const kb = KeyboardProvider.blockKeyboard(postId, false, false, postById[postId]?.channel)
			await telegram.sendMessage(userId, text, {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...kb
			})
			// Помечаем после успешной отправки: упавшая рассылка не должна съесть
			// видео, которых пользователь не видел.
			if (postId) shownIds.push(postId)
		}

		markDigestShown(userId, shownIds)

		const moreKb = KeyboardProvider.videoMoreKeyboard(picked.remaining)
		if (moreKb) {
			await telegram.sendMessage(userId, "…", { parse_mode: "HTML", ...moreKb })
		}

		return shownIds.length
	}

	hasRankings(userId, date) {
		return getRankedPostIds(userId, date, 1).length > 0
	}

	async ensureRankings(userId, userProfile) {
		const date = this.digestDate()
		if (this.hasRankings(userId, date)) {
			console.log(`[ensureRankings] Rankings already exist for userId=${userId} date=${date}`)
			return
		}

		let allPosts = getPostsForCalendarDay(date)
		console.log(`[ensureRankings] userId=${userId} date=${date} allPosts=${allPosts.length}`)

		// If no posts or too few (< 5) — fetch last 72 hours to ensure we cover the digest period
		// Using 72h instead of 48h to account for timezone differences and ensure we don't miss posts
		if (allPosts.length < 5) {
			console.log(`[ensureRankings] Not enough posts (${allPosts.length}), fetching...`)
			const nowTs = Math.floor(Date.now() / 1000)
			const sinceTs = nowTs - 72 * 60 * 60
			await collectChannelPosts({ sinceTs, untilTs: nowTs })
			allPosts = getPostsForCalendarDay(date)
			console.log(`[ensureRankings] After fetch: allPosts=${allPosts.length}`)
		}

		const posts = this.filterPostsForUser(allPosts, userId)
		console.log(`[ensureRankings] After filter: posts=${posts.length}`)
		if (posts.length === 0) {
			console.log(`[ensureRankings] No posts after filter for userId=${userId}`)
			return
		}

		const priorities = getUserChannelPriorities(userId)
		const feedback = getPostFeedbackForRanking(userId)
		const user = getUser(userId)
		const systemPrompt = await getUserSystemPrompt(user)

		console.log(`[ensureRankings] Calling rankPosts with ${posts.length} posts...`)
		let ranked
		try {
			ranked = await this.mgr.ai.rankPosts(posts, userProfile, { channelPriorities: priorities, feedback, systemPrompt })
		} catch (e) {
			console.error(`[ensureRankings] rankPosts error:`, e.message)
			throw e // Re-throw to let caller handle
		}
		
		if (!ranked || ranked.length === 0) {
			console.error(`[ensureRankings] rankPosts returned empty result`)
			return
		}
		
		console.log(`[ensureRankings] Ranked ${ranked.length} posts, inserting...`)
		clearRankingsForUser(userId, date)

		const items = ranked.map((r) => ({
			id: uuidv4(),
			post_id: r.post_id,
			score: r.score,
			reason: r.reason
		}))
		insertRankings(userId, date, items)
		console.log(`[ensureRankings] Inserted ${items.length} rankings for userId=${userId} date=${date}`)
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
		console.log("[getDigestPostIds] userId:", userId, "date:", date, "limit:", limit, "offset:", offset)

		// Debug: check what scores we have in DB
		const allRankings = getRankedPostIds(userId, date, 100, 0)
		console.log("[getDigestPostIds] allRankings in DB:", allRankings.length)

		// Adaptive threshold: start with MIN_DIGEST_SCORE (0.5)
		let threshold = MIN_DIGEST_SCORE

		// Get all posts with score >= 0.5
		const idsAbove = getRankedPostIdsAboveScore(userId, date, threshold, 10000, 0)

		console.log("[getDigestPostIds] idsAbove.length (score >= 0.5):", idsAbove.length)

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
					console.log("[getDigestPostIds] returning sorted, total:", allIds.length)
					return {
						postIds: allIds.slice(offset, offset + limit),
						total: allIds.length,
						threshold: 0.75
					}
				}
				console.log("[getDigestPostIds] returning idsAboveEvenHigher, total:", idsAboveEvenHigher.length)
				return {
					postIds: idsAboveEvenHigher.slice(offset, offset + limit),
					total: idsAboveEvenHigher.length,
					threshold
				}
			}
			console.log("[getDigestPostIds] returning idsAboveHigher, total:", idsAboveHigher.length)
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
			console.log("[getDigestPostIds] returning idsAboveLower, total:", idsAboveLower.length)
			return {
				postIds: idsAboveLower.slice(offset, offset + limit),
				total: idsAboveLower.length,
				threshold
			}
		}

		// If no posts with score >= 0.5, take all
		const allIds = idsAbove.length === 0 ? getRankedPostIds(userId, date, 10000, 0) : idsAbove
		console.log("[getDigestPostIds] returning allIds/idsAbove, total:", allIds.length)
		return {
			postIds: allIds.slice(offset, offset + limit),
			total: allIds.length,
			threshold
		}
	}

	/** Get filtered posts (score 0.3-0.5) that were excluded from main digest */
	getFilteredPostIds(userId, date, limit = 7) {
		console.log("[getFilteredPostIds] userId:", userId, "date:", date, "limit:", limit)
		
		// Get posts with score 0.3-0.5 (filtered out from main digest)
		const allIds = getRankedPostIds(userId, date, 10000, 0)
		const rankingsMap = getRankingsMap(userId, date)
		
		// Filter by score range 0.3-0.5 and sort by score desc
		const filteredIds = allIds
			.filter(id => {
				const rank = rankingsMap[id]
				return rank && rank.score >= 0.3 && rank.score < 0.5
			})
			.sort((a, b) => {
				const scoreA = rankingsMap[a]?.score || 0
				const scoreB = rankingsMap[b]?.score || 0
				return scoreB - scoreA
			})
			.slice(0, limit)
		
		console.log("[getFilteredPostIds] filteredIds.length:", filteredIds.length)
		return {
			postIds: filteredIds,
			total: filteredIds.length,
			threshold: 0.3
		}
	}

	async digestReply(ctx, offset = 0, count = DIGEST_PAGE_SIZE, status = null) {
		const userId = ctx.from?.id
		const date = this.digestDate()
		
		// First check if we have rankings
		let { postIds, total } = this.getDigestPostIds(userId, date, count, offset)

		console.log("[digestReply] userId:", userId, "offset:", offset, "count:", count, "postIds.length:", postIds.length, "total:", total)

		// If no posts — try to fetch them
		if (postIds.length === 0) {
			if (status) {
				await status.percent("⏳ <b>No ranked posts — fetching from channels...</b>", 50)
			}
			// Fetch posts from 48 hours ago
			const nowTs = Math.floor(Date.now() / 1000)
			const sinceTs = nowTs - 48 * 60 * 60
			await collectChannelPosts({ sinceTs, untilTs: nowTs })
			
			// Re-build rankings
			const user = getOrCreateUser(userId)
			await this.ensureRankings(userId, user.profile || "")
			
			// Check again
			const result = this.getDigestPostIds(userId, date, count, offset)
			postIds = result.postIds
			total = result.total
			
			if (status) {
				await status.percent(`⏳ <b>Posts fetched: ${total} posts</b>`, 70)
			}
		}

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
			systemPrompt,
			compact: getDigestFormat(userId) === "compact"
		})

		console.log("[digestReply] result.blocks.length:", result.blocks.length)

		const postById = UIFormatter.buildPostById(posts)
		const rankMap = getRankingsMap(userId, date)
		const compact = getDigestFormat(userId) === "compact"

		// Get total collected posts count for stats
		const allPostsCount = getPostsForCalendarDay(date).length

		const header = UIFormatter.formatDigestHeader(label, result.teaser, result.blocks.length, { total, allPostsCount })

		// Calculate next offset and check if more posts available
		const nextOffset = offset + count
		const hasMore = nextOffset < total

		console.log("[digestReply] nextOffset:", nextOffset, "hasMore:", hasMore)

		const row = []
		if (hasMore) {
			row.push({ text: "▶️ More 5", callback_data: `more:${nextOffset}:5` })
			row.push({ text: "▶️ More 10", callback_data: `more:${nextOffset}:10` })
		}
		row.push({ text: "📋 Summary", callback_data: "summary" })

		// Add button for filtered posts (score 0.3-0.5) if we have main digest posts
		const hasFilteredButton = offset === 0 && count === DIGEST_PAGE_SIZE && total > 0
		const filteredRow = []
		if (hasFilteredButton) {
			filteredRow.push({ text: "📬 Show next 7 (lower score)", callback_data: "filtered:7" })
		}

		// Replace status message with digest header (100%)
		if (status) {
			const keyboard = [row]
			if (filteredRow.length > 0) keyboard.push(filteredRow)
			await status.replace(header, { reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true, parse_mode: "HTML" })
		} else {
			const keyboard = [row]
			if (filteredRow.length > 0) keyboard.push(filteredRow)
			await ctx.telegram.sendMessage(ctx.chat.id, header, {
				parse_mode: "HTML",
				reply_markup: { inline_keyboard: keyboard },
				disable_web_page_preview: true
			})
		}

		for (const [index, block] of result.blocks.entries()) {
			const postId = block.ids.length === 1 ? block.ids[0] : null
			const reason = postId ? rankMap[postId]?.reason : null
			const channel = postId && postById[postId] ? postById[postId].channel : null
			const blockText = UIFormatter.formatBlockText(block, postById, { compact, isTop: index === 0 })
			const kb = KeyboardProvider.blockKeyboard(postId, !!reason, false, channel)

			await ctx.telegram.sendMessage(ctx.chat.id, blockText, {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...kb
			})
			if (postId) this.mgr.cache.setBlock(postId, { normalText: blockText, block, postById, reason })
		}

		// Add digest feedback buttons at the end
		const feedbackKeyboard = {
			inline_keyboard: [
				[
					{ text: "👍 Полезно", callback_data: `digest_fb:${date}:1` },
					{ text: "😐 Так себе", callback_data: `digest_fb:${date}:0` },
					{ text: "👎 Мимо", callback_data: `digest_fb:${date}:-1` }
				]
			]
		}
		await ctx.telegram.sendMessage(ctx.chat.id, "📊 <b>Насколько полезен дайджест?</b>", {
			parse_mode: "HTML",
			reply_markup: feedbackKeyboard
		})

		// Track digest open in stats
		upsertUserStat(userId, date, { digest_opened: 1, posts_read: result.blocks.length })
	}

	/** Show filtered posts (score 0.3-0.5) as additional digest */
	async showFilteredPosts(ctx, limit = 7) {
		const userId = ctx.from?.id
		if (!userId) return

		const date = this.digestDate()
		const { postIds, total } = this.getFilteredPostIds(userId, date, limit)

		if (postIds.length === 0) {
			return ctx.reply("ℹ️ <b>No filtered posts</b>\n\nAll posts with score >= 0.3 are already shown in the main digest.", { parse_mode: "HTML" })
		}

		const posts = getPostsByIds(postIds)
		const orderMap = Object.fromEntries(postIds.map((id, i) => [id, i]))
		posts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

		const user = getOrCreateUser(userId)
		const label = formatDateLabel(date)
		const systemPrompt = await getUserSystemPrompt(user)

		// Generate blocks for filtered posts
		const result = await this.mgr.ai.generateSummaryBlocks(posts, label, user.profile || "", limit, { systemPrompt, compact: getDigestFormat(userId) === "compact" })

		if (!result.blocks?.length) {
			return ctx.reply("⚠️ Failed to generate blocks for filtered posts.", { parse_mode: "HTML" })
		}

		// Header for filtered posts
		const header = `📬 <b>Additional posts (${postIds.length})</b>\n\n<i>These posts had lower scores (0.3-0.5) but may still be interesting.</i>`

		await ctx.reply(header, { parse_mode: "HTML" })

		const postById = UIFormatter.buildPostById(posts)
		const rankMap = getRankingsMap(userId, date)
		const compact = getDigestFormat(userId) === "compact"

		for (const [index, block] of result.blocks.entries()) {
			const postId = block.ids.length === 1 ? block.ids[0] : null
			const reason = postId ? rankMap[postId]?.reason : null
			const channel = postId && postById[postId] ? postById[postId].channel : null
			const blockText = UIFormatter.formatBlockText(block, postById, { compact, isTop: index === 0 })
			const kb = KeyboardProvider.blockKeyboard(postId, !!reason, false, channel)

			await ctx.telegram.sendMessage(ctx.chat.id, blockText, {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...kb
			})
			if (postId) this.mgr.cache.setBlock(postId, { normalText: blockText, block, postById, reason })
		}

		// Add back button
		const backKeyboard = {
			inline_keyboard: [[{ text: "📰 Back to digest", callback_data: "digest" }]]
		}
		await ctx.reply("📊 <b>Насколько полезен дайджест?</b>", {
			parse_mode: "HTML",
			reply_markup: {
				inline_keyboard: [
					[
						{ text: "👍 Полезно", callback_data: `digest_fb:${date}:1` },
						{ text: "😐 Так себе", callback_data: `digest_fb:${date}:0` },
						{ text: "👎 Мимо", callback_data: `digest_fb:${date}:-1` }
					],
					[{ text: "📰 Back to digest", callback_data: "digest" }]
				]
			}
		})
	}

	getRanking(userId, postId) {
		return getRankingByUserAndPost(userId, postId, this.digestDate())
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
			systemPrompt,
			compact: getDigestFormat(userId) === "compact"
		})
		const postById = UIFormatter.buildPostById(rankedPosts)
		const rankMap = getRankingsMap(userId, dateStr)
		const compact = getDigestFormat(userId) === "compact"

		if (options.messageToEdit) await ctx.telegram.deleteMessage(chatId, options.messageToEdit).catch(() => { })

		const header = UIFormatter.formatDigestHeader(label, result.teaser, result.blocks.length, { total })
		const hasMore = offset + maxItems < total
		const row = []
		if (hasMore) row.push({ text: `▶️ More ${maxItems}`, callback_data: `summary_more:${dateStr}:${offset + maxItems}:${maxItems}` })
		row.push({ text: "📋 Menu", callback_data: "menu" })

		await ctx.telegram.sendMessage(chatId, header, { 
			parse_mode: "HTML", 
			disable_web_page_preview: true,
			reply_markup: { inline_keyboard: [row] } 
		})
		for (const [index, block] of result.blocks.entries()) {
			const postId = block.ids.length === 1 ? block.ids[0] : null
			const reason = postId ? rankMap[postId]?.reason : null
			const channel = postId && postById[postId] ? postById[postId].channel : null
			const blockText = UIFormatter.formatBlockText(block, postById, { compact, isTop: index === 0 })
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
		// Morning digest at 07:00 MSK shows digest for "yesterday" (06:00 MSK yesterday to 06:00 MSK today)
		// Use getDigestDate() which returns yesterday before 06:00 MSK, today after
		// At 07:00 MSK, getDigestDate() returns "today", so we need to subtract 1 day
		const digestDate = getDigestDate()
		const digestDateObj = new Date(digestDate)
		digestDateObj.setDate(digestDateObj.getDate() - 1)
		const digestDateStr = digestDateObj.toISOString().slice(0, 10)
		const failures = []

		for (const u of users) {
			try {
				await this.ensureRankingsForDate(u.user_id, digestDateStr, u.profile || "")
				const payload = await this.buildDigestBlocksForDate(u.user_id, digestDateStr)
				if (!payload) continue

				const teaserText = payload.teaser
					? `☀️ <b>Вчера главное:</b> ${UIFormatter.escapeHtml(payload.teaser)}\n\n<i>Разбор ниже.</i>`
					: "☀️ <b>Вчерашний дайджест готов</b>. Смотри ниже."

				await botInstance.telegram.sendMessage(u.user_id, teaserText, {
					parse_mode: "HTML",
					reply_markup: { inline_keyboard: [[{ text: "📰 Открыть дайджест", callback_data: "digest" }]] },
					disable_web_page_preview: true
				})

				await botInstance.telegram.sendMessage(u.user_id, payload.header, { parse_mode: "HTML", disable_web_page_preview: true })
				await botInstance.telegram.sendMessage(u.user_id, "<b>Top picks for you:</b>", { parse_mode: "HTML", disable_web_page_preview: true })

				const compact = getDigestFormat(u.user_id) === "compact"
				for (const [index, block] of payload.blocks.entries()) {
					const postId = block.ids.length === 1 ? block.ids[0] : null
					const reason = postId ? payload.rankMap[postId]?.reason : null
					const channel = postId && payload.postById[postId] ? payload.postById[postId].channel : null
					const blockText = UIFormatter.formatBlockText(block, payload.postById, { compact, isTop: index === 0 })
					const kb = KeyboardProvider.blockKeyboard(postId, !!reason, false, channel)
					await botInstance.telegram.sendMessage(u.user_id, blockText, {
						parse_mode: "HTML",
						disable_web_page_preview: true,
						...kb
					})
					if (postId) this.mgr.cache.setBlock(postId, { normalText: blockText, block, postById: payload.postById, reason })
				}

				await this.sendVideoSection(botInstance.telegram, u.user_id)

				// Add digest feedback buttons
				const feedbackKeyboard = {
					inline_keyboard: [
						[
							{ text: "👍 Полезно", callback_data: `digest_fb:${digestDateStr}:1` },
							{ text: "😐 Так себе", callback_data: `digest_fb:${digestDateStr}:0` },
							{ text: "👎 Мимо", callback_data: `digest_fb:${digestDateStr}:-1` }
						]
					]
				}
				await botInstance.telegram.sendMessage(u.user_id, "📊 <b>Насколько полезен дайджест?</b>", {
					parse_mode: "HTML",
					reply_markup: feedbackKeyboard
				})

				// Track digest open
				upsertUserStat(u.user_id, digestDateStr, { digest_opened: 1, posts_read: payload.blocks.length })
			} catch (e) {
				console.error("[morning digest] user", u.user_id, e)
				failures.push({ userId: u.user_id, message: e.message })
				try {
					await botInstance.telegram.sendMessage(u.user_id,
						"⚠️ <b>Дайджест сегодня недоступен</b>\n\nРанжирование не отработало. Посты собраны — открой /digest и посмотри вручную.",
						{ parse_mode: "HTML" }
					)
				} catch {}
			}
		}

		await this.#reportDigestFailures(botInstance, failures, users.length, digestDateStr)
	}

	/**
	 * A silent morning digest is indistinguishable from a working one, so a failed run
	 * has to reach the admin — the last outage went unnoticed for three weeks.
	 */
	async #reportDigestFailures(botInstance, failures, totalUsers, digestDateStr) {
		if (failures.length === 0) return

		const adminId = parseInt(process.env.ADMIN_ID, 10) || 0
		if (!adminId) return

		const detail = failures
			.slice(0, 5)
			.map((f) => `• <code>${f.userId}</code>: ${UIFormatter.escapeHtml(String(f.message).slice(0, 200))}`)
			.join("\n")
		const more = failures.length > 5 ? `\n…и ещё ${failures.length - 5}` : ""

		try {
			await botInstance.telegram.sendMessage(adminId,
				`🚨 <b>Дайджест за ${digestDateStr} не ушёл</b>\n\nУпало ${failures.length} из ${totalUsers}.\n\n${detail}${more}`,
				{ parse_mode: "HTML", disable_web_page_preview: true }
			)
		} catch (e) {
			console.error("[morning digest] admin alert failed:", e.message)
		}
	}

	async buildDigestBlocks(userId) {
		const date = this.digestDate()
		const { postIds, total } = this.getDigestPostIds(userId, date, DIGEST_PAGE_SIZE, 0)
		if (postIds.length === 0) return null

		const posts = getPostsByIds(postIds)
		const orderMap = Object.fromEntries(postIds.map((id, i) => [id, i]))
		posts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

		const user = getOrCreateUser(userId)
		const label = formatDateLabel(date)
		const systemPrompt = await getUserSystemPrompt(user)
		const result = await this.mgr.ai.generateSummaryBlocks(posts, label, user.profile || "", user.digest_max_items, { systemPrompt, compact: getDigestFormat(userId) === "compact" })
		if (!result.blocks?.length) return null

		// Get total collected posts count for stats
		const allPostsCount = getPostsForCalendarDay(date).length

		return {
			header: UIFormatter.formatDigestHeader("morning", result.teaser, result.blocks.length, { morning: true, total, allPostsCount }),
			teaser: result.teaser,
			blocks: result.blocks,
			postById: UIFormatter.buildPostById(posts),
			rankMap: getRankingsMap(userId, date)
		}
	}

	async buildDigestBlocksForDate(userId, date) {
		const { postIds, total } = this.getDigestPostIds(userId, date, DIGEST_PAGE_SIZE, 0)
		if (postIds.length === 0) return null

		const posts = getPostsByIds(postIds)
		const orderMap = Object.fromEntries(postIds.map((id, i) => [id, i]))
		posts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

		const user = getOrCreateUser(userId)
		const label = formatDateLabel(date)
		const systemPrompt = await getUserSystemPrompt(user)
		const result = await this.mgr.ai.generateSummaryBlocks(posts, label, user.profile || "", user.digest_max_items, { systemPrompt, compact: getDigestFormat(userId) === "compact" })
		if (!result.blocks?.length) return null

		// Get total collected posts count for stats
		const allPostsCount = getPostsForCalendarDay(date).length

		return {
			header: UIFormatter.formatDigestHeader(label, result.teaser, result.blocks.length, { total, allPostsCount }),
			teaser: result.teaser,
			blocks: result.blocks,
			postById: UIFormatter.buildPostById(posts),
			rankMap: getRankingsMap(userId, date)
		}
	}
}
