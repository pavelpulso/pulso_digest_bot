import { v4 as uuidv4 } from "uuid"
import {
	getRankedPostIds,
	getPostsLast24h,
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
	getUsersForMorningDigest
} from "../db.js"
import { formatDateLabel, MIN_DIGEST_SCORE, DIGEST_PAGE_SIZE } from "../utils.js"
import { UIFormatter } from "../ui/UIFormatter.js"
import { KeyboardProvider } from "../ui/KeyboardProvider.js"

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

		const allPosts = getPostsLast24h()
		const posts = this.filterPostsForUser(allPosts, userId)
		if (posts.length === 0) return

		const priorities = getUserChannelPriorities(userId)
		const feedback = getPostFeedbackForRanking(userId)

		const ranked = await this.mgr.ai.rankPosts(posts, userProfile, { channelPriorities: priorities, feedback })
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

	getDigestPostIds(userId, date, limit, offset) {
		const idsAbove = getRankedPostIdsAboveScore(userId, date, MIN_DIGEST_SCORE, 10000, 0)
		const allIds = idsAbove.length < 3 ? getRankedPostIds(userId, date, 10000, 0) : idsAbove
		return {
			postIds: allIds.slice(offset, offset + limit),
			total: allIds.length
		}
	}

	async digestReply(ctx, offset = 0, count = DIGEST_PAGE_SIZE) {
		const userId = ctx.from?.id
		const date = this.todayDate()
		const { postIds, total } = this.getDigestPostIds(userId, date, count, offset)

		if (postIds.length === 0) return ctx.reply("No posts yet. Add channels or wait for /fetch.")

		const posts = getPostsByIds(postIds)
		const orderMap = Object.fromEntries(postIds.map((id, i) => [id, i]))
		posts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

		const user = getOrCreateUser(userId)
		const label = formatDateLabel(date)
		const result = await this.mgr.ai.generateSummaryBlocks(posts, label, user.profile || "", user.digest_max_items)

		const postById = UIFormatter.buildPostById(posts)
		const rankMap = getRankingsMap(userId, date)
		const compact = getDigestFormat(userId) === "compact"

		const header = UIFormatter.formatDigestHeader(label, result.teaser, result.blocks.length)
		const row = []
		if (offset + count < total) {
			row.push({ text: "▶️ Ещё 5", callback_data: `more:${offset + count}:5` })
			row.push({ text: "▶️ Ещё 10", callback_data: `more:${offset + count}:10` })
		}
		row.push({ text: "📋 Summary", callback_data: "summary" })

		await ctx.telegram.sendMessage(ctx.chat.id, header, {
			parse_mode: "HTML",
			reply_markup: { inline_keyboard: [row] }
		})

		for (const block of result.blocks) {
			const postId = block.ids.length === 1 ? block.ids[0] : null
			const reason = postId ? rankMap[postId]?.reason : null
			const blockText = UIFormatter.formatBlockText(block, postById, { compact })
			const kb = KeyboardProvider.blockKeyboard(postId, !!reason, false)

			await ctx.telegram.sendMessage(ctx.chat.id, blockText, { parse_mode: "HTML", ...kb })
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
		return `👤 <b>Your Profile</b>\n\n` +
			`<b>Interests:</b>\n${UIFormatter.escapeHtml(profile)}\n\n` +
			`<b>Digest Size:</b> ${maxItems} items\n` +
			`<b>Format:</b> ${format}\n` +
			`<b>Minus keywords:</b> ${UIFormatter.escapeHtml(keywords)}\n\n` +
			`Use buttons to edit settings.`
	}
	async sendSummaryBlocks(ctx, dateStr, label, offset = 0, options = {}) {
		const userId = ctx.from?.id
		const user = getOrCreateUser(userId)
		const maxItems = options.maxItems || (user.digest_max_items ?? 7)
		const chatId = options.chatId || ctx.chat?.id

		const since = `${dateStr}T00:00:00.000Z`
		const until = new Date(new Date(since).getTime() + 24 * 60 * 60 * 1000).toISOString()
		let posts = getPostsForDateRange(since, until)

		// Helper: isAdPost (move this logic here or import it)
		const isAdPost = (p) => {
			const t = (p.text || "").toLowerCase()
			return (t.includes("реклама") && (t.includes("инн") || t.includes("erid")))
		}

		posts = this.filterPostsForUser(posts.filter(p => !isAdPost(p)), userId)

		if (posts.length === 0) return ctx.telegram.sendMessage(chatId, "No posts for the selected day.")

		// For summary we need ensureRankingsForUserAndPosts - I should check if it's available or move it
		// For now assume it will be in mgr.service or similar
		const { postIds, total } = getRankedPostIdsWithTotal(userId, dateStr, maxItems, offset, 0)

		const rankedPosts = getPostsByIds(postIds)
		const orderMap = Object.fromEntries(postIds.map((id, i) => [id, i]))
		rankedPosts.sort((a, b) => orderMap[a.id] - orderMap[b.id])

		const result = await this.mgr.ai.generateSummaryBlocks(rankedPosts, label, user.profile || "", maxItems)
		const postById = UIFormatter.buildPostById(rankedPosts)
		const rankMap = getRankingsMap(userId, dateStr)
		const compact = getDigestFormat(userId) === "compact"

		if (options.messageToEdit) await ctx.telegram.deleteMessage(chatId, options.messageToEdit).catch(() => { })

		const header = UIFormatter.formatDigestHeader(label, result.teaser, result.blocks.length)
		const hasMore = offset + maxItems < total
		const row = []
		if (hasMore) row.push({ text: `▶️ Ещё ${maxItems}`, callback_data: `summary_more:${dateStr}:${offset + maxItems}:${maxItems}` })
		row.push({ text: "📋 Меню", callback_data: "menu" })

		await ctx.telegram.sendMessage(chatId, header, { parse_mode: "HTML", reply_markup: { inline_keyboard: [row] } })
		for (const block of result.blocks) {
			const postId = block.ids.length === 1 ? block.ids[0] : null
			const reason = postId ? rankMap[postId]?.reason : null
			const blockText = UIFormatter.formatBlockText(block, postById, { compact })
			const kb = KeyboardProvider.blockKeyboard(postId, !!reason, false)
			await ctx.telegram.sendMessage(chatId, blockText, { parse_mode: "HTML", ...kb })
			if (postId) this.mgr.cache.setBlock(postId, { normalText: blockText, block, postById, reason })
		}
	}

	async sendMorningDigests(botInstance) {
		const users = getUsersForMorningDigest()
		for (const u of users) {
			try {
				await this.ensureRankings(u.user_id, u.profile || "")
				const payload = await this.buildDigestBlocks(u.user_id)
				if (!payload) continue

				const teaserText = payload.teaser
					? `☀️ <b>Главное утром:</b> ${UIFormatter.escapeHtml(payload.teaser)}\n\n<i>Открой дайджест — ниже полный разбор.</i>`
					: "☀️ Дайджест готов. Открой ниже."

				await botInstance.telegram.sendMessage(u.user_id, teaserText, {
					parse_mode: "HTML",
					reply_markup: { inline_keyboard: [[{ text: "📰 Открыть дайджест", callback_data: "digest" }]] }
				})

				await botInstance.telegram.sendMessage(u.user_id, payload.header, { parse_mode: "HTML" })
				await botInstance.telegram.sendMessage(u.user_id, "<b>Главное для тебя:</b>", { parse_mode: "HTML" })

				const compact = getDigestFormat(u.user_id) === "compact"
				for (const block of payload.blocks) {
					const postId = block.ids.length === 1 ? block.ids[0] : null
					const reason = postId ? payload.rankMap[postId]?.reason : null
					const blockText = UIFormatter.formatBlockText(block, payload.postById, { compact })
					const kb = KeyboardProvider.blockKeyboard(postId, !!reason, false)
					await botInstance.telegram.sendMessage(u.user_id, blockText, { parse_mode: "HTML", ...kb })
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
		const result = await this.mgr.ai.generateSummaryBlocks(posts, label, user.profile || "", user.digest_max_items)
		if (!result.blocks?.length) return null

		return {
			header: UIFormatter.formatDigestHeader("утро", result.teaser, result.blocks.length, { morning: true }),
			teaser: result.teaser,
			blocks: result.blocks,
			postById: UIFormatter.buildPostById(posts),
			rankMap: getRankingsMap(userId, date)
		}
	}
}
