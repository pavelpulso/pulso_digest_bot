import { BaseHandler } from "./BaseHandler.js"
import {
	setBotOpen,
	getStats,
	banUserByUsernameOrId,
	unbanUserByUsernameOrId,
	getSetting,
	getActiveYouTubeChannels,
	getDormantYouTubeChannelsDueForRecheck
} from "../db.js"
import { ACTIVE_DAYS, RECHECK_DAYS } from "../youtube/collector.js"

export class AdminHandler extends BaseHandler {
	isAdmin(userId) {
		const adminId = parseInt(process.env.ADMIN_ID, 10)
		return Number.isInteger(adminId) && userId === adminId
	}

	handleStats(ctx) {
		if (!this.isAdmin(ctx.from?.id)) return
		const s = getStats()
		return ctx.reply(`Users: ${s.users}\nChannels: ${s.channels}\nPosts: ${s.posts}`)
	}

	handleBan(ctx) {
		if (!this.isAdmin(ctx.from?.id)) return
		const match = ctx.message.text.replace(/^\/ban\s*/i, "").trim()
		if (!match) return ctx.reply("Usage: /ban @username or user_id")
		const res = banUserByUsernameOrId(match)
		return ctx.reply(res.ok ? `User ${res.user_id} banned.` : "User not found.")
	}

	handleUnban(ctx) {
		if (!this.isAdmin(ctx.from?.id)) return
		const match = ctx.message.text.replace(/^\/unban\s*/i, "").trim()
		if (!match) return ctx.reply("Usage: /unban @username or user_id")
		const res = unbanUserByUsernameOrId(match)
		return ctx.reply(res.ok ? `User ${res.user_id} unbanned.` : "User not found.")
	}

	handleOpen(ctx, open) {
		if (!this.isAdmin(ctx.from?.id)) return
		setBotOpen(open)
		return ctx.reply(open ? "Bot is open." : "Bot is closed.")
	}

	handleYtStatus(ctx) {
		if (!this.isAdmin(ctx.from?.id)) return

		const active = getActiveYouTubeChannels(ACTIVE_DAYS).length
		const dormant = getDormantYouTubeChannelsDueForRecheck(ACTIVE_DAYS, RECHECK_DAYS).length

		const raw = getSetting("yt_last_warnings")
		if (!raw) {
			return ctx.reply(`📺 YouTube status\n\nChannels: ${active} active, ${dormant} dormant\nNo collection run recorded yet.`)
		}

		let snapshot
		try {
			snapshot = JSON.parse(raw)
		} catch (e) {
			return ctx.reply(`📺 YouTube status\n\nChannels: ${active} active, ${dormant} dormant\n⚠️ Last run snapshot is unreadable (corrupt stored value).`)
		}

		const { warnings, collected, ranAt } = snapshot
		const shown = warnings.slice(0, 5)
		const omitted = warnings.length - shown.length
		const warningsText = shown.length
			? shown.map((w) => `• ${w}`).join("\n") + (omitted > 0 ? `\n... and ${omitted} more` : "")
			: "No warnings."

		return ctx.reply(
			"📺 YouTube status\n\n" +
			`Last run: ${new Date(ranAt).toLocaleString()}\n` +
			`Collected: ${collected}\n` +
			`Channels: ${active} active, ${dormant} dormant\n\n` +
			`Warnings:\n${warningsText}`
		)
	}
}
