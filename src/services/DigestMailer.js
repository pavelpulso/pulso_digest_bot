import nodemailer from "nodemailer"

const ENTITIES = { "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&amp;": "&" }

export function htmlToText(html) {
	return html
		.replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gs, "$2 ($1)")
		.replace(/<[^>]+>/g, "")
		.replace(/&(lt|gt|quot|#39|amp);/g, (m) => ENTITIES[m])
}

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

	async send({ subject, header, blockTexts }) {
		const parts = [header, ...blockTexts]
		const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:640px">${parts.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("\n")}</body></html>`
		const text = parts.map(htmlToText).join("\n\n")
		this.transport ??= nodemailer.createTransport(this.url)
		await this.transport.sendMail({ from: this.from, to: this.to, subject, html, text })
	}
}
