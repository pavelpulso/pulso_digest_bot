import { Markup } from "telegraf"
import {
	BTN_DIGEST,
	BTN_SUMMARY,
	BTN_CHANNELS,
	BTN_PROFILE,
	BTN_ANALYZE_CHANNEL,
	BTN_CHANNEL_AUDIT,
	BTN_SETTINGS,
	BTN_MINUS_WORDS,
	BTN_DIGEST_MAX_ITEMS,
	BTN_DIGEST_FORMAT,
	BTN_EDIT_PROFILE,
	BTN_SYSTEM_PROMPT,
	BTN_ADD_CHANNEL,
	BTN_REMOVE_CHANNEL,
	BTN_BACK,
	BTN_FETCH
} from "./ButtonLabels.js"

export class KeyboardProvider {
	static mainReply() {
		return {
			reply_markup: {
				keyboard: [
					[BTN_DIGEST, BTN_SUMMARY],
					[BTN_CHANNELS, BTN_PROFILE],
					[BTN_ANALYZE_CHANNEL, BTN_CHANNEL_AUDIT],
					[BTN_SETTINGS, BTN_FETCH]
				],
				resize_keyboard: true
			}
		}
	}

	static settings() {
		return {
			reply_markup: {
				keyboard: [
					[BTN_MINUS_WORDS],
					[BTN_DIGEST_MAX_ITEMS],
					[BTN_DIGEST_FORMAT],
					["⏸ Pause digest"],
					["📊 My stats"],
					[BTN_EDIT_PROFILE],
					[BTN_BACK]
				],
				resize_keyboard: true
			}
		}
	}

	static channels() {
		return {
			reply_markup: {
				keyboard: [
					[BTN_ADD_CHANNEL, BTN_REMOVE_CHANNEL],
					[BTN_BACK]
				],
				resize_keyboard: true
			}
		}
	}

	static profile() {
		return {
			reply_markup: {
				keyboard: [
					[BTN_EDIT_PROFILE],
					[BTN_SYSTEM_PROMPT],
					[BTN_DIGEST_MAX_ITEMS, BTN_MINUS_WORDS, BTN_DIGEST_FORMAT],
					[BTN_BACK]
				],
				resize_keyboard: true
			}
		}
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
		dates.push([Markup.button.callback(BTN_BACK, "menu")])
		return Markup.inlineKeyboard(dates)
	}

	static fetchDays() {
		return Markup.inlineKeyboard([
			[Markup.button.callback("1 day", "fetch:1")],
			[Markup.button.callback("3 days", "fetch:3")],
			[Markup.button.callback("7 days", "fetch:7")],
			[Markup.button.callback(BTN_BACK, "menu")]
		])
	}

	static analyzeChannelList(channels) {
		if (!channels || channels.length === 0) return undefined

		const buttons = channels.map((ch) =>
			Markup.button.callback(`📊 @${ch.username}`, `analyze_ch:${ch.username}`)
		)

		const rows = []
		for (let i = 0; i < buttons.length; i += 2) {
			rows.push(buttons.slice(i, i + 2))
		}
		rows.push([Markup.button.callback(BTN_BACK, "menu")])

		return Markup.inlineKeyboard(rows)
	}

	/**
	 * Inline keyboard for channel analysis result.
	 * @param {string} channelName - channel username (without @)
	 * @param {boolean} isAdded - Whether channel is already added
	 */
	static analyzeChannelResult(channelName, isAdded = false) {
		const cleanName = channelName.replace(/^@/, "")
		const buttons = []

		if (!isAdded) {
			buttons.push([
				Markup.button.callback("✅ Add channel", `channel_add:${cleanName}`),
				Markup.button.callback("❌ Skip", `channel_skip:${cleanName}`)
			])
		} else {
			buttons.push([
				Markup.button.callback("✓ Channel added", `channel_skip:${cleanName}`)
			])
		}

		buttons.push([Markup.button.callback("🔍 Analyze another", "analyze_channel_menu")])

		return Markup.inlineKeyboard(buttons)
	}

	/**
	 * Keyboard for post block.
	 * @param {string|null} postId - Post ID
	 * @param {boolean} hasWhy - Has AI explanation
	 * @param {boolean} expanded - Is expanded mode (reason shown)
	 * @param {string|null} channel - Channel username (for hide button)
	 * @param {boolean} isHidden - Is channel already hidden
	 */
	static blockKeyboard(postId, hasWhy = false, expanded = false, channel = null, isHidden = false) {
		if (!postId) return undefined
		const feedbackRow = [
			{ text: "👍", callback_data: `fb:${postId}:1` },
			{ text: "👎", callback_data: `fb:${postId}:-1` }
		]

		// Hiding a channel is rare and destructive — it lives one tap in, behind Details,
		// so a stray thumb on the digest cannot silently drop a source.
		const actionRow = []
		if (channel) {
			actionRow.push({
				text: isHidden ? "👁 Вернуть канал" : "🙈 Скрыть канал",
				callback_data: `toggle_hidden:${channel}`
			})
		}

		if (expanded) {
			return {
				reply_markup: {
					inline_keyboard: [
						feedbackRow,
						actionRow,
						[{ text: "↩ Свернуть", callback_data: `why_collapse:${postId}` }]
					]
				}
			}
		}
		if (hasWhy) feedbackRow.push({ text: "📌 Почему", callback_data: `why:${postId}` })

		return {
			reply_markup: {
				inline_keyboard: [feedbackRow]
			}
		}
	}

	static videoMoreKeyboard(remaining, batchSize = remaining) {
		if (!remaining || remaining <= 0) return undefined
		const count = Math.min(remaining, batchSize)
		return {
			reply_markup: {
				inline_keyboard: [[
					{ text: `📺 Ещё ${count} видео`, callback_data: "video_more" }
				]]
			}
		}
	}
}
