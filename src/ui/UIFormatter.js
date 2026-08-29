import { MAX_MESSAGE_LEN } from "../utils.js"

export class UIFormatter {
	/** Escapes Markdown characters in text. */
	static escapeMarkdown(text) {
		if (!text || typeof text !== "string") return ""
		return text.replace(/([*_`[\]])/g, "\\$1")
	}

	/** Escapes HTML. */
	static escapeHtml(text) {
		if (!text || typeof text !== "string") return ""
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
	}

	/** Digest header. */
	static formatDigestHeader(label, teaser, count, opts = {}) {
		const suffix = opts.morning ? "\n\n<i>/digest — more posts</i>" : ""
		const safeLabel = this.escapeHtml(label)
		const safeTeaser = teaser ? this.escapeHtml(teaser) : ""

		// Build header with post count info
		let header
		if (safeTeaser) {
			header = `📰 <b>Digest for ${safeLabel}</b>\n\n<b>Highlights:</b> ${safeTeaser}\n\n(${count} items)${suffix}`
		} else {
			header = `📰 <b>Digest for ${safeLabel}</b> (${count} items)${suffix}`
		}

		// Add stats: collected vs filtered
		if (opts.allPostsCount !== undefined) {
			const filtered = opts.allPostsCount - count
			header += `\n\n<i>📥 Collected: ${opts.allPostsCount} posts | 🎯 Filtered: ${filtered} posts</i>`
		} else if (opts.total !== undefined && opts.total !== count) {
			header += `\n\n<i>Filtered from ${opts.total} posts</i>`
		}

		return header.trim()
	}

	/** Map id -> {channel, postUrl, date, duration_sec, views} */
	static buildPostById(posts) {
		return Object.fromEntries(
			posts.map((p) => {
				const postUrl =
					p.link && String(p.link).endsWith("/" + p.post_id) ? p.link : `https://t.me/${p.channel}/${p.post_id}`
				return [p.id, { channel: p.channel, postUrl, date: p.date, duration_sec: p.duration_sec, views: p.views }]
			})
		)
	}

	/** Publication time in Moscow, the reader's timezone — empty when the post carries no date. */
	static formatPostTime(date) {
		if (!date) return ""
		const d = new Date(date)
		if (Number.isNaN(d.getTime())) return ""
		return new Intl.DateTimeFormat("ru-RU", {
			timeZone: "Europe/Moscow",
			hour: "2-digit",
			minute: "2-digit"
		}).format(d)
	}

	/** Block format: essence → action → potential → links. */
	static formatBlockText(block, postById, options = {}) {
		const { compact = false, isTop = false } = options
		const e = this.escapeHtml.bind(this)
		const essence = e(block.essence)
		const potential = e(block.potential)
		const action = e(block.action || "")

		let linksLine
		if (block.ids.length === 1) {
			const { channel, postUrl, date } = postById[block.ids[0]] || { channel: "channel", postUrl: "#" }
			const safeUrl = postUrl.replace(/&/g, "&amp;")
			const time = this.formatPostTime(date)
			linksLine = `<a href="${safeUrl}">↗ @${this.escapeHtml(channel)}</a>${time ? ` · 🕘 ${time}` : ""}`
		} else {
			const parts = block.ids.map((id) => {
				const { channel, postUrl } = postById[id] || { channel: "channel", postUrl: "#" }
				const safeUrl = postUrl.replace(/&/g, "&amp;")
				return `<a href="${safeUrl}">@${this.escapeHtml(channel)}</a>`
			})
			linksLine = parts.join(" · ")
		}

		const headline = isTop ? `🔥 <b>${essence}</b>` : `${block.emoji} ${essence}`

		if (compact) {
			const text = `${headline}\n\n${linksLine}`
			return text.length > MAX_MESSAGE_LEN ? text.slice(0, MAX_MESSAGE_LEN - 1) + "…" : text
		}

		const actionLine = action ? `⚡ <b>${action}</b>` : null
		const lines = [
			headline,
			...(actionLine ? [actionLine] : []),
			...(potential ? [`💡 ${potential}`] : []),
			linksLine
		]
		const text = lines.join("\n\n")
		return text.length > MAX_MESSAGE_LEN ? text.slice(0, MAX_MESSAGE_LEN - 1) + "…" : text
	}

	static formatDuration(sec) {
		if (!sec || sec <= 0) return ""
		const totalMin = Math.round(sec / 60)
		if (totalMin < 60) return `${totalMin} мин`
		return `${Math.floor(totalMin / 60)} ч ${totalMin % 60} мин`
	}

	static formatViews(views) {
		if (!views || views <= 0) return ""
		if (views < 1000) return String(views)
		if (views < 999_500) return `${Math.round(views / 1000)}k`
		return `${(views / 1_000_000).toFixed(1)}M`
	}

	/** Как текстовый блок, но вторая строка несёт длительность и просмотры — по ним решают, открывать ли. */
	static formatVideoBlockText(block, postById) {
		const essence = this.escapeHtml(block.essence)
		const meta = postById[block.ids[0]] || {}
		const safeUrl = String(meta.postUrl || "#").replace(/&/g, "&amp;")
		const channel = this.escapeHtml(String(meta.channel || "").replace(/^yt:/, ""))

		const parts = [
			`<a href="${safeUrl}">▶ ${channel}</a>`,
			this.formatDuration(meta.duration_sec),
			this.formatViews(meta.views)
		].filter(Boolean)

		return `${block.emoji || "🎬"} ${essence}\n\n${parts.join(" · ")}`
	}

	/** Verdict -> emoji and label */
	static verdictLabel(verdict) {
		if (verdict === "keep") return { emoji: "🟢", label: "KEEP" }
		if (verdict === "unsubscribe") return { emoji: "🔴", label: "UNSUBSCRIBE" }
		return { emoji: "🟡", label: "WATCH" }
	}
}
