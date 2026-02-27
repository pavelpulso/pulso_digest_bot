import { UIFormatter } from "../ui/UIFormatter.js"

/**
 * Класс для управления статусными сообщениями в командах бота.
 * Реализует единую логику отображения прогресса выполнения задач.
 *
 * Использование:
 *   const status = new StatusMessage(ctx)
 *   await status.start("⏳ Начинаю...")
 *   await status.update("⏳ Делаю...")
 *   await status.replace("✅ Готово!", { reply_markup: ... })
 */
export class StatusMessage {
	constructor(ctx) {
		this.ctx = ctx
		this.messageId = null
		this.chatId = ctx.chat?.id
		this.currentPercent = null
	}

	/**
	 * Показать стартовое сообщение
	 * @param {string} text — текст сообщения
	 * @returns {Promise<void>}
	 */
	async start(text) {
		const safeText = UIFormatter.escapeHtml(text)
		const msg = await this.ctx.reply(safeText, { parse_mode: "HTML" })
		this.messageId = msg.message_id
		this.currentPercent = null
	}

	/**
	 * Показать стартовое сообщение с прогрессом в процентах
	 * @param {string} text — текст сообщения
	 * @param {number} percent — текущий прогресс (0-100)
	 * @returns {Promise<void>}
	 */
	async startProgress(text, percent) {
		const safeText = UIFormatter.escapeHtml(text)
		const fullText = `${safeText} <b>${percent}%</b>`
		const msg = await this.ctx.reply(fullText, { parse_mode: "HTML" })
		this.messageId = msg.message_id
		this.currentPercent = percent
	}

	/**
	 * Обновить текст статусного сообщения
	 * @param {string} text — новый текст
	 * @returns {Promise<void>}
	 */
	async update(text) {
		if (!this.messageId) return
		const safeText = UIFormatter.escapeHtml(text)
		try {
			await this.ctx.telegram.editMessageText(
				this.chatId,
				this.messageId,
				null,
				safeText,
				{ parse_mode: "HTML" }
			)
		} catch (e) {
			// Игнорируем ошибки редактирования (сообщение могло быть удалено)
			console.warn("[StatusMessage.update] error:", e.message)
		}
	}

	/**
	 * Обновить прогресс в процентах
	 * @param {string} text — базовый текст
	 * @param {number} percent — текущий прогресс (0-100)
	 * @returns {Promise<void>}
	 */
	async percent(text, percent) {
		this.currentPercent = percent
		const safeText = UIFormatter.escapeHtml(text)
		const fullText = `${safeText} <b>${percent}%</b>`
		await this.update(fullText)
	}

	/**
	 * Обновить только процент без смены текста (использует последний текст)
	 * @param {number} percent — текущий прогресс (0-100)
	 * @returns {Promise<void>}
	 */
	async updatePercent(percent) {
		// Метод устарел, используйте percent(text, percent) вместо этого
		// Оставлен для обратной совместимости
		if (!this.messageId) return
		this.currentPercent = percent
	}

	/**
	 * Заменить статусное сообщение на результат
	 * @param {string} text — текст результата
	 * @param {object} options — опции Telegram API (reply_markup, parse_mode и т.д.)
	 * @returns {Promise<void>}
	 */
	async replace(text, options = {}) {
		const safeText = UIFormatter.escapeHtml(text)
		if (!this.messageId) {
			await this.ctx.reply(safeText, { parse_mode: "HTML", ...options })
			return
		}
		try {
			await this.ctx.telegram.editMessageText(
				this.chatId,
				this.messageId,
				null,
				safeText,
				{ parse_mode: "HTML", ...options }
			)
		} catch (e) {
			// Если не удалось отредактировать — отправляем новое сообщение
			console.warn("[StatusMessage.replace] edit failed, sending new:", e.message)
			await this.ctx.reply(safeText, { parse_mode: "HTML", ...options })
		}
	}

	/**
	 * Удалить статусное сообщение
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
	 * Получить ID текущего сообщения
	 * @returns {number|null}
	 */
	getId() {
		return this.messageId
	}
}
