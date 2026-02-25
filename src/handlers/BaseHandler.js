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
		const oneLine = raw.replace(/\s+/g, " ").trim()
		return oneLine.length > 250 ? oneLine.slice(0, 247) + "…" : oneLine
	}
}
