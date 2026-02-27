import { UIFormatter } from "../ui/UIFormatter.js"

/**
 * Status message manager for bot commands.
 * Provides unified progress display logic.
 *
 * Usage:
 *   const status = new StatusMessage(ctx)
 *   await status.start("⏳ Starting...")
 *   await status.update("⏳ Processing...")
 *   await status.replace("✅ Done!", { reply_markup: ... })
 */
export class StatusMessage {
	constructor(ctx) {
		this.ctx = ctx
		this.messageId = null
		this.chatId = ctx.chat?.id
		this.currentPercent = null
	}

	/**
	 * Show start message
	 * @param {string} text — message text (may contain HTML)
	 * @returns {Promise<void>}
	 */
	async start(text) {
		const msg = await this.ctx.reply(text, { parse_mode: "HTML" })
		this.messageId = msg.message_id
		this.currentPercent = null
	}

	/**
	 * Show start message with progress percentage
	 * @param {string} text — message text (may contain HTML)
	 * @param {number} percent — current progress (0-100)
	 * @returns {Promise<void>}
	 */
	async startProgress(text, percent) {
		const fullText = `${text} <b>${percent}%</b>`
		const msg = await this.ctx.reply(fullText, { parse_mode: "HTML" })
		this.messageId = msg.message_id
		this.currentPercent = percent
	}

	/**
	 * Update status message text
	 * @param {string} text — new text (may contain HTML)
	 * @returns {Promise<void>}
	 */
	async update(text) {
		if (!this.messageId) return
		try {
			await this.ctx.telegram.editMessageText(
				this.chatId,
				this.messageId,
				null,
				text,
				{ parse_mode: "HTML" }
			)
		} catch (e) {
			// Ignore edit errors (message may have been deleted)
			console.warn("[StatusMessage.update] error:", e.message)
		}
	}

	/**
	 * Update progress percentage
	 * @param {string} text — base text (may contain HTML)
	 * @param {number} percent — current progress (0-100)
	 * @param {string} [detail] — additional info (e.g. "45/100 channels — 3/7 batches")
	 * @returns {Promise<void>}
	 */
	async percent(text, percent, detail = "") {
		this.currentPercent = percent
		const safeDetail = detail ? `\n<i>${UIFormatter.escapeHtml(detail)}</i>` : ""
		const fullText = `${text}\n<b>${percent}%</b>${safeDetail}`
		await this.update(fullText)
	}

	/**
	 * Update only percentage without changing text (uses last text)
	 * @param {number} percent — current progress (0-100)
	 * @returns {Promise<void>}
	 */
	async updatePercent(percent) {
		// Deprecated, use percent(text, percent) instead
		// Kept for backward compatibility
		if (!this.messageId) return
		this.currentPercent = percent
	}

	/**
	 * Replace status message with result
	 * @param {string} text — result text (may contain HTML)
	 * @param {object} options — Telegram API options (reply_markup, parse_mode, etc.)
	 * @returns {Promise<void>}
	 */
	async replace(text, options = {}) {
		if (!this.messageId) {
			await this.ctx.reply(text, { parse_mode: "HTML", ...options })
			return
		}
		try {
			await this.ctx.telegram.editMessageText(
				this.chatId,
				this.messageId,
				null,
				text,
				{ parse_mode: "HTML", ...options }
			)
		} catch (e) {
			const errMsg = e.message || ""
			// If message wasn't modified, ignore silently
			if (errMsg.includes("message is not modified") || errMsg.includes("message is not changed")) {
				return
			}
			// If edit failed, send a new message
			console.warn("[StatusMessage.replace] edit failed, sending new:", e.message)
			await this.ctx.reply(text, { parse_mode: "HTML", ...options })
		}
	}

	/**
	 * Remove status message
	 * @returns {Promise<void>}
	 */
	async remove() {
		if (!this.messageId) return
		try {
			await this.ctx.telegram.deleteMessage(this.chatId, this.messageId)
		} catch (e) {
			console.warn("[StatusMessage.remove] error:", e.message)
		}
		this.messageId = null
	}

	/**
	 * Get current message ID
	 * @returns {number|null}
	 */
	getId() {
		return this.messageId
	}
}
