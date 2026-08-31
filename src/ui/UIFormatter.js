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

	/** Map id -> {channel, postUrl, duration_sec, views} */
	static buildPostById(posts) {
		return Object.fromEntries(
			posts.map((p) => {
				// У видео ссылка своей формы (?v=<id>), и telegram-фолбэк дал бы несуществующий адрес.
				const postUrl = p.source === "yt"
					? p.link
					: p.link && String(p.link).endsWith("/" + p.post_id) ? p.link : `https://t.me/${p.channel}/${p.post_id}`
				return [p.id, { channel: p.channel, postUrl, duration_sec: p.duration_sec, views: p.views }]
			})
		)
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

	/**
	 * Как текстовый блок, но заголовок — собственный заголовок видео (первая строка text),
	 * а не сгенерированная моделью суть: модель видео не смотрит, только пересказывает
	 * title+description. Вторая строка несёт длительность и просмотры — по ним решают, открывать ли.
	 */
	static formatVideoBlockText(video, postById) {
		// clean_title is generated once at selection time; a video without one (not yet
		// processed, or the rewrite failed) falls back to the raw first line, which is the
		// whole reason this section does not depend on the model to send.
		const rawTitle = String(video.text || "").split("\n")[0].trim()
		const title = this.escapeHtml(video.clean_title ? String(video.clean_title).trim() : rawTitle)
		const meta = postById[video.id] || {}
		const safeUrl = String(meta.postUrl || "#").replace(/&/g, "&amp;")
		const channel = this.escapeHtml(String(meta.channel || "").replace(/^yt:/, ""))

		const parts = [
			`<a href="${safeUrl}">▶ ${channel}</a>`,
			this.formatDuration(meta.duration_sec),
			this.formatViews(meta.views)
		].filter(Boolean)

		return `🎬 ${title}\n\n${parts.join(" · ")}`
	}

	/** Verdict -> emoji and label */
	static verdictLabel(verdict) {
		if (verdict === "keep") return { emoji: "🟢", label: "KEEP" }
		if (verdict === "unsubscribe") return { emoji: "🔴", label: "UNSUBSCRIBE" }
		return { emoji: "🟡", label: "WATCH" }
	}
}
