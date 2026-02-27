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
			[Markup.button.callback("1 день", "fetch:1")],
			[Markup.button.callback("3 дня", "fetch:3")],
			[Markup.button.callback("7 дней", "fetch:7")],
			[Markup.button.callback(BTN_BACK, "menu")]
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
