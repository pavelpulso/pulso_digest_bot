import { test } from "node:test"
import assert from "node:assert/strict"

process.env.DB_PATH = ":memory:"
const db = await import("../src/db.js")

test("a post defaults to the telegram source, so existing rows keep working", () => {
	db.upsertPost("p1", "somechannel", 100, "текст", "https://t.me/somechannel/100", 5, "2026-08-29T10:00:00.000Z")
	const post = db.getPostById("p1")
	assert.equal(post.source, "tg")
})

test("shown videos are remembered per user", () => {
	db.getOrCreateUser(42)
	db.getOrCreateUser(43)
	db.markDigestShown(42, ["v1", "v2"])
	const shown = db.getShownPostIds(42)
	assert.ok(shown.has("v1"))
	assert.ok(shown.has("v2"))
	assert.ok(!db.getShownPostIds(43).has("v1"), "another user has their own history")
})

test("marking the same video twice does not throw", () => {
	db.markDigestShown(42, ["v1"])
	db.markDigestShown(42, ["v1"])
	assert.ok(db.getShownPostIds(42).has("v1"))
})

test("the same video is not offered twice", async () => {
	// Медиана канала: 5 созревших видео по 1000 просмотров
	for (let i = 0; i < 5; i++) {
		db.upsertVideo(`m${i}`, "yt:@c", `mature${i}`, "старое", "https://youtube.com/watch?v=x", 1000, 600,
			new Date(Date.now() - (10 + i) * 86400_000).toISOString())
	}
	db.upsertVideo("fresh1", "yt:@c", "freshA", "свежее А", "https://youtube.com/watch?v=a", 20000, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("fresh2", "yt:@c", "freshB", "свежее Б", "https://youtube.com/watch?v=b", 15000, 600,
		new Date(Date.now() - 86400_000).toISOString())

	const first = db.getVideoCandidates(7, new Set())
	assert.equal(first.length, 2, "both fresh videos are candidates, matured ones are outside the window")

	const second = db.getVideoCandidates(7, new Set(["fresh1"]))
	assert.ok(!second.some((v) => v.id === "fresh1"), "a shown video drops out of the pool")
})

test("the channel norm comes from matured videos only", () => {
	const norms = db.getChannelViewNorms(7, 90)
	const norm = norms.get("yt:@c")
	assert.ok(norm, "the channel has a norm")
	assert.equal(norm.maturedCount, 5)
	assert.equal(norm.medianViews, 1000, "fresh 20k and 15k videos must not drag the norm up")
})

test("a user with no hidden channels and an empty shown set still gets candidates", () => {
	db.getOrCreateUser(45)
	const candidates = db.getVideoCandidates(7, new Set(), 45)
	assert.ok(candidates.some((v) => v.id === "fresh1"), "no hidden channels means nothing is excluded")
})

test("videos do not leak into the telegram post selection", () => {
	db.upsertVideo("v9", "yt:@chan", "abc123", "заголовок", "https://youtube.com/watch?v=abc123", 1000, 600, "2026-08-29T10:00:00.000Z")
	const dayPosts = db.getPostsForCalendarDay("2026-08-29")
	assert.ok(!dayPosts.some((p) => p.id === "v9"), "a video must not appear among text posts")
})

test("a ranked video does not leak into getRankedPostIds", () => {
	db.getOrCreateUser(44)
	db.upsertVideo("v10", "yt:@chan2", "def456", "заголовок2", "https://youtube.com/watch?v=def456", 500, 300, "2026-08-29T11:00:00.000Z")
	db.insertRankings(44, "2026-08-29", [{ id: "rank-v10", post_id: "v10", score: 0.9, reason: "r" }])
	const ids = db.getRankedPostIds(44, "2026-08-29")
	assert.ok(!ids.includes("v10"), "a video must not appear among ranked telegram posts")
})

test("a video block shows the two numbers a viewer decides by", async () => {
	const { UIFormatter } = await import("../src/ui/UIFormatter.js")

	const block = { ids: ["v1"], essence: "Автор разбирает архитектуру воркеров", emoji: "🎬" }
	const postById = {
		v1: { channel: "yt:@chan", postUrl: "https://www.youtube.com/watch?v=abc", duration_sec: 1320, views: 47000 }
	}

	const text = UIFormatter.formatVideoBlockText(block, postById)
	assert.match(text, /22 мин/, "duration in minutes")
	assert.match(text, /47k/, "views abbreviated")
	assert.match(text, /@chan/)
})

test("durations and views read as a human would write them", async () => {
	const { UIFormatter } = await import("../src/ui/UIFormatter.js")
	assert.equal(UIFormatter.formatDuration(90), "2 мин")
	assert.equal(UIFormatter.formatDuration(3600), "1 ч 0 мин")
	assert.equal(UIFormatter.formatDuration(7260), "2 ч 1 мин")
	assert.equal(UIFormatter.formatViews(999), "999")
	assert.equal(UIFormatter.formatViews(47000), "47k")
	assert.equal(UIFormatter.formatViews(1500000), "1.5M")
	assert.equal(UIFormatter.formatViews(999500), "1.0M")
	assert.equal(UIFormatter.formatViews(999999), "1.0M")
})

test("no tail means no button", async () => {
	const { KeyboardProvider } = await import("../src/ui/KeyboardProvider.js")
	assert.equal(KeyboardProvider.videoMoreKeyboard(0), undefined)
	const kb = KeyboardProvider.videoMoreKeyboard(7)
	assert.match(kb.reply_markup.inline_keyboard[0][0].text, /Ещё 7/)
})

test("a failing video section leaves the text digest sent", async () => {
	const sent = []
	const telegram = {
		sendMessage: async (chatId, text) => { sent.push(text); return { message_id: sent.length } }
	}

	const service = {
		selectVideosForDigest: async () => { throw new Error("AI down") },
		sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
	}

	const count = await service.sendVideoSection.call(service, telegram, 42, {})
	assert.equal(count, 0, "the section reports nothing sent")
	assert.equal(sent.length, 0, "and sends nothing, rather than throwing into the caller")
})
