import nodemailer from "nodemailer"

const ENTITIES = { "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&amp;": "&" }

const escapeHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const nl2br = (s) => s.replace(/\n/g, "<br>")

export function htmlToText(html) {
	return html
		.replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gs, "$2 ($1)")
		.replace(/<[^>]+>/g, "")
		.replace(/&(lt|gt|quot|#39|amp);/g, (m) => ENTITIES[m])
}

const sourceHtml = (s) => `<blockquote style="margin:8px 0 16px;padding-left:12px;border-left:3px solid #ccc;color:#333"><a href="${escapeHtml(s.url)}">@${escapeHtml(s.channel)}</a><br>${nl2br(escapeHtml(s.text))}</blockquote>`
const sourceText = (s) => `@${s.channel} — ${s.url}\n${s.text ?? ""}`

/** Mails the morning digest to one inbox, so assistants that read mail (ChatGPT, Gmail) see it too. */
export class DigestMailer {
	constructor({ url = process.env.SMTP_URL, to = process.env.DIGEST_EMAIL_TO, from = process.env.DIGEST_EMAIL_FROM, transport } = {}) {
		this.url = url
		this.to = to
		this.from = from || to
		this.transport = transport
	}

	isReady() {
		return Boolean(this.to && (this.transport || this.url))
	}

	async send({ subject, header, blocks }) {
		const htmlParts = [`<p>${nl2br(header)}</p>`, ...blocks.map((b) => `<p>${nl2br(b.text)}</p>${b.sources.map(sourceHtml).join("")}`)]
		const textParts = [htmlToText(header), ...blocks.map((b) => [htmlToText(b.text), ...b.sources.map(sourceText)].join("\n\n"))]
		const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:640px">${htmlParts.join("\n")}</body></html>`
		this.transport ??= nodemailer.createTransport(this.url)
		await this.transport.sendMail({ from: this.from, to: this.to, subject, html, text: textParts.join("\n\n") })
	}
}
