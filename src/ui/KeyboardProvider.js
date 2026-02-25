import { Markup } from "telegraf"

export class KeyboardProvider {
	static mainReply() {
		return Markup.keyboard([
			["📰 Digest", "📋 Summary"],
			["📢 Channels", "👤 Profile"],
			["📱 Menu"]
		]).resize()
	}

	static mainMenu() {
		return Markup.inlineKeyboard([
			[
				Markup.button.callback("📰 Digest", "digest"),
				Markup.button.callback("📋 Summary", "summary"),
				Markup.button.callback("📢 Channels", "channels")
			],
			[
				Markup.button.callback("👤 Profile", "profile"),
				Markup.button.callback("➕ Add channel", "add_channels"),
				Markup.button.callback("➖ Remove channel", "remove_channel")
			]
		])
	}

	static channels() {
		return Markup.inlineKeyboard([
			[
				Markup.button.callback("➕ Add channel", "add_channels"),
				Markup.button.callback("➖ Remove channel", "remove_channel")
			],
			[Markup.button.callback("⚙ Channel settings", "channel_settings")]
		])
	}

	static summaryDate() {
		const dates = []
		const now = new Date()
		for (let i = 0; i < 7; i++) {
			const d = new Date(now)
			d.setDate(d.getDate() - i)
			const str = d.toISOString().slice(0, 10)
			dates.push([Markup.button.callback(str, `summary_day:${str}`)])
		}
		dates.push([Markup.button.callback("📅 Weekly Summary (last 7 days)", "summary_weekly")])
		return Markup.inlineKeyboard(dates)
	}

	static profile() {
		return Markup.inlineKeyboard([
			[Markup.button.callback("📝 Edit Profile (Interests)", "edit_profile")],
			[Markup.button.callback("🔢 Digest items count", "edit_digest_max")],
			[Markup.button.callback("🚫 Minus keywords", "edit_minus_keywords")],
			[Markup.button.callback("📦 Digest format (Full/Compact)", "edit_digest_format")],
			[Markup.button.callback("📱 Back to Menu", "menu")]
		])
	}

	static blockKeyboard(postId, hasWhy = false, expanded = false) {
		if (!postId) return undefined
		const feedbackRow = [
			{ text: "👍 Релевантно", callback_data: `fb:${postId}:1` },
			{ text: "👎 Не релевантно", callback_data: `fb:${postId}:-1` }
		]
		if (expanded) {
			return {
				reply_markup: {
					inline_keyboard: [
						feedbackRow,
						[{ text: "↩ Свернуть", callback_data: `why_collapse:${postId}` }]
					]
				}
			}
		}
		if (hasWhy) feedbackRow.push({ text: "📌 Подробнее", callback_data: `why:${postId}` })
		return {
			reply_markup: {
				inline_keyboard: [feedbackRow]
			}
		}
	}
}
