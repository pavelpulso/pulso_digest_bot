export class BaseHandler {
	constructor(botManager) {
		this.mgr = botManager
	}

	/** Ответ на callback_query без падения при "query is too old". */
	async safeAnswerCbQuery(ctx, text) {
		try {
			await ctx.answerCbQuery(text)
		} catch (_) { }
	}

	/** Короткое описание ошибки для чата. */
	formatErrorForChat(e) {
		const raw = (e && (e.message || e.reason)) || String(e)
		
		// Специальная обработка ошибок Gemini API
		if (raw.includes("Gemini API")) {
			if (raw.includes("429")) {
				return "Сервис перегружен (лимит запросов). Подождите минуту и попробуйте снова."
			}
			if (raw.includes("500") || raw.includes("405")) {
				return "Сервис временно недоступен. Попробуйте позже."
			}
			return "Ошибка сервиса суммаризации. Попробуйте позже."
		}
		
		// Обработка ошибок GramJS/Telegram
		if (raw.includes("TIMEOUT") || raw.includes("ECONNRESET")) {
			return "Проблема соединения с Telegram. Попробуйте позже."
		}
		
		// Общая ошибка
		const oneLine = raw.replace(/\s+/g, " ").trim()
		return oneLine.length > 250 ? oneLine.slice(0, 247) + "…" : oneLine
	}
}
