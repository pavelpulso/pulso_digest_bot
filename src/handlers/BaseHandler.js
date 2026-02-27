export class BaseHandler {
	constructor(botManager) {
		this.mgr = botManager
	}

	/** Answer callback_query without errors on "query is too old". */
	async safeAnswerCbQuery(ctx, text) {
		try {
			await ctx.answerCbQuery(text)
		} catch {
			// Ignore error
		}
	}

	/** Short error description for chat. */
	formatErrorForChat(e) {
		const raw = (e && (e.message || e.reason)) || String(e)

		// Special handling for Gemini API errors
		if (raw.includes("Gemini API")) {
			if (raw.includes("429")) {
				return "Service overloaded (rate limit). Wait a minute and try again."
			}
			if (raw.includes("500") || raw.includes("405")) {
				return "Service temporarily unavailable. Try later."
			}
			return "Summarization service error. Try later."
		}

		// Handle GramJS/Telegram errors
		if (raw.includes("TIMEOUT") || raw.includes("ECONNRESET")) {
			return "Telegram connection issue. Try later."
		}

		// Generic error
		const oneLine = raw.replace(/\s+/g, " ").trim()
		return oneLine.length > 250 ? oneLine.slice(0, 247) + "…" : oneLine
	}
}
