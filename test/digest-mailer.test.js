import { test } from "node:test"
import assert from "node:assert/strict"
import { DigestMailer, htmlToText } from "../src/services/DigestMailer.js"

function recordingTransport() {
	const sent = []
	return { sent, sendMail: async (msg) => { sent.push(msg) } }
}

test("htmlToText keeps link targets and decodes entities", () => {
	const text = htmlToText("<b>AI &amp; ML</b>\n<a href=\"https://t.me/x/1\">source</a> &lt;3")
	assert.equal(text, "AI & ML\nsource (https://t.me/x/1) <3")
})

test("not ready without a recipient or SMTP", () => {
	assert.equal(new DigestMailer({ url: "", to: "a@b.c" }).isReady(), false)
	assert.equal(new DigestMailer({ url: "smtp://x", to: "" }).isReady(), false)
	assert.equal(new DigestMailer({ url: "smtp://x", to: "a@b.c" }).isReady(), true)
})

test("send puts every block into one mail with html and text parts", async () => {
	const transport = recordingTransport()
	const mailer = new DigestMailer({ to: "me@example.com", from: "bot@example.com", transport })
	await mailer.send({ subject: "Pulso 2026-10-04", header: "<b>Digest</b>", blockTexts: ["one\ntwo", "<i>three</i>"] })

	assert.equal(transport.sent.length, 1)
	const [msg] = transport.sent
	assert.equal(msg.to, "me@example.com")
	assert.equal(msg.from, "bot@example.com")
	assert.equal(msg.subject, "Pulso 2026-10-04")
	assert.match(msg.html, /one<br>two/)
	assert.match(msg.html, /<i>three<\/i>/)
	assert.equal(msg.text, "Digest\n\none\ntwo\n\nthree")
})
