import { BaseHandler } from "./BaseHandler.js"
import { setBotOpen, getStats, banUserByUsernameOrId, unbanUserByUsernameOrId } from "../db.js"

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
}
