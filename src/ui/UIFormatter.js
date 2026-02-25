import { MAX_MESSAGE_LEN } from "../utils.js"

export class UIFormatter {
	/** Экранирует символы Markdown в тексте. */
	static escapeMarkdown(text) {
		if (!text || typeof text !== "string") return ""
		return text.replace(/([*_`\[\]])/g, "\\$1")
	}

	/** Экранирует HTML. */
	static escapeHtml(text) {
		if (!text || typeof text !== "string") return ""
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
	}

	/** Заголовок дайджеста. */
	static formatDigestHeader(label, teaser, count, opts = {}) {
		const suffix = opts.morning ? "\n\n<i>/digest — ещё постов</i>" : ""
		const safeLabel = this.escapeHtml(label)
		const safeTeaser = teaser ? this.escapeHtml(teaser) : ""
		if (safeTeaser) {
			return `📰 <b>Дайджест за ${safeLabel}</b>\n\n<b>Главное:</b> ${safeTeaser}\n\n(${count} пунктов)${suffix}`.trim()
		}
		return `📰 <b>Дайджест за ${safeLabel}</b> (${count} пунктов)${suffix}`.trim()
	}

	/** Карта id -> {channel, postUrl} */
	static buildPostById(posts) {
		return Object.fromEntries(
			posts.map((p) => {
				const postUrl =
					p.link && String(p.link).endsWith("/" + p.post_id) ? p.link : `https://t.me/${p.channel}/${p.post_id}`
				return [p.id, { channel: p.channel, postUrl }]
			})
		)
	}

	/** Формат блока: суть → действие → потенциал → ссылки. */
	static formatBlockText(block, postById, options = {}) {
		const { compact = false } = options
		const e = this.escapeHtml.bind(this)
		const essence = e(block.essence)
		const potential = e(block.potential)
		const action = e(block.action || "")

		let linksLine
		if (block.ids.length === 1) {
			const { channel, postUrl } = postById[block.ids[0]] || { channel: "channel", postUrl: "#" }
			const safeUrl = postUrl.replace(/&/g, "&amp;")
			linksLine = `<a href="${safeUrl}">↗ @${this.escapeHtml(channel)}</a>`
		} else {
			const parts = block.ids.map((id) => {
				const { channel, postUrl } = postById[id] || { channel: "channel", postUrl: "#" }
				const safeUrl = postUrl.replace(/&/g, "&amp;")
				return `<a href="${safeUrl}">@${this.escapeHtml(channel)}</a>`
			})
			linksLine = parts.join(" · ")
		}

		if (compact) {
			const text = `${block.emoji} ${essence}\n\n${linksLine}`
			return text.length > MAX_MESSAGE_LEN ? text.slice(0, MAX_MESSAGE_LEN - 1) + "…" : text
		}

		const actionLine = action ? `⚡ <b>${action}</b>` : null
		const lines = [
			`${block.emoji} ${essence}`,
			...(actionLine ? [actionLine] : []),
			...(potential ? [`💡 ${potential}`] : []),
			linksLine
		]
		const text = lines.join("\n\n")
		return text.length > MAX_MESSAGE_LEN ? text.slice(0, MAX_MESSAGE_LEN - 1) + "…" : text
	}

	/** Вердикт аналитики -> эмодзи и заголовок */
	static verdictLabel(verdict) {
		if (verdict === "keep") return { emoji: "🟢", label: "ДЕРЖИ" }
		if (verdict === "unsubscribe") return { emoji: "🔴", label: "ОТПИШИСЬ" }
		return { emoji: "🟡", label: "НАБЛЮДАЙ" }
	}
}
