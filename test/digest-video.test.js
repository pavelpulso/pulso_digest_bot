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

// Video tests below share one in-memory DB and getVideoCandidates has no channel
// scoping — a test appended at the end with yt-source rows dated today pollutes the
// 7-day window counts of earlier tests. Snapshot/hide/mark-shown defensively instead
// of relying on position in the file.

test("the same video is not offered twice", async () => {
	// Медиана канала: 5 созревших видео по 1000 просмотров
	for (let i = 0; i < 5; i++) {
		db.upsertVideo(`m${i}`, "yt:@c", `mature${i}`, "старое", "https://youtube.com/watch?v=x", 1000, 600,
			new Date(Date.now() - (10 + i) * 86400_000).toISOString())
	}
	db.upsertVideo("fresh1", "yt:@c", "freshA", "свежее А", "https://youtube.com/watch?v=a", 20000, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("fresh2", "yt:@c2", "freshB", "свежее Б", "https://youtube.com/watch?v=b", 15000, 600,
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

test("getVideoCandidates excludes videos from a channel the user hid", () => {
	db.getOrCreateUser(50)
	db.upsertVideo("hid1", "yt:@hidechan", "hidv1", "скрытое видео", "https://youtube.com/watch?v=hid1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.setUserChannelHidden(50, "yt:@hidechan", true)

	const candidates = db.getVideoCandidates(7, new Set(), 50)
	assert.ok(!candidates.some((v) => v.id === "hid1"), "a hidden channel's video is excluded")
})

test("selectVideosForDigest never calls the AI when there are no candidates", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 47
	db.getOrCreateUser(userId)
	const existing = db.getVideoCandidates(7, new Set())
	db.markDigestShown(userId, existing.map((v) => v.id))

	let called = false
	const service = new BotService({
		ai: { rankPosts: async () => { called = true; throw new Error("must not be called") } }
	})
	const result = await service.selectVideosForDigest(userId)

	assert.deepEqual(result.videos, [])
	assert.equal(result.remaining, 0)
	assert.equal(called, false, "an empty candidate list must not spend an AI call")
})

test("more candidates than the daily cap keep only the cap, remaining reflects the excess", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 48
	db.getOrCreateUser(userId)
	const existing = db.getVideoCandidates(7, new Set())
	db.markDigestShown(userId, existing.map((v) => v.id))

	for (let i = 0; i < 35; i++) {
		db.upsertVideo(`cap${i}`, `yt:@capchan${i}`, `capvid${i}`, `видео ${i}`, `https://youtube.com/watch?v=cap${i}`, 100, 600,
			new Date(Date.now() - 86400_000).toISOString())
	}

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 1 })) }
	})
	const result = await service.selectVideosForDigest(userId)
	assert.equal(result.videos.length, 3, "lead count is 3")
	assert.equal(result.remaining, 27, "cap 30 minus lead 3")
})

test("fewer candidates than the daily cap leave nothing remaining", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 49
	db.getOrCreateUser(userId)
	const existing = db.getVideoCandidates(7, new Set())
	db.markDigestShown(userId, existing.map((v) => v.id))

	db.upsertVideo("two1", "yt:@twochan1", "twov1", "видео 1", "https://youtube.com/watch?v=two1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("two2", "yt:@twochan2", "twov2", "видео 2", "https://youtube.com/watch?v=two2", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 1 })) }
	})
	const result = await service.selectVideosForDigest(userId)
	assert.equal(result.videos.length, 2)
	assert.equal(result.remaining, 0, "not negative")
})

test("hidden channels are excluded end-to-end from selectVideosForDigest", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 51
	db.getOrCreateUser(userId)
	db.upsertVideo("hidden1", "yt:@hiddenchan", "hidv2", "скрытое", "https://youtube.com/watch?v=hidden1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.setUserChannelHidden(userId, "yt:@hiddenchan", true)

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: p.id === "hidden1" ? 999 : 0.1 })) }
	})
	const result = await service.selectVideosForDigest(userId)
	assert.ok(!result.videos.some((v) => v.id === "hidden1"), "hidden channel's video never reaches the digest")
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

test("a telegram send that fails mid-section does not throw, and reports what actually went out", async () => {
	db.getOrCreateUser(60)
	const videos = [
		{ id: "sv1", channel: "yt:@sendfail", post_id: "sv1", link: null, date: "2026-08-01T00:00:00.000Z", duration_sec: 100, views: 10 },
		{ id: "sv2", channel: "yt:@sendfail", post_id: "sv2", link: null, date: "2026-08-01T00:00:00.000Z", duration_sec: 100, views: 10 }
	]

	let calls = 0
	const telegram = {
		sendMessage: async () => {
			calls += 1
			if (calls === 2) throw new Error("Telegram rejected the message")
			return { message_id: calls }
		}
	}

	const service = {
		selectVideosForDigest: async () => ({ videos, remaining: 0 }),
		mgr: {
			ai: {
				generateSummaryBlocks: async () => ({
					blocks: [{ ids: ["sv1"], essence: "e1", emoji: "🎬" }, { ids: ["sv2"], essence: "e2", emoji: "🎬" }]
				})
			}
		},
		sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
	}

	let count
	await assert.doesNotReject(async () => {
		count = await service.sendVideoSection.call(service, telegram, 60, { withHeader: false })
	})
	assert.equal(count, 1, "only the video sent before the failure is reported")
	assert.ok(db.getShownPostIds(60).has("sv1"), "the delivered video is marked shown")
	assert.ok(!db.getShownPostIds(60).has("sv2"), "the video whose send failed is not marked shown")
})

test("a video link survives the trip from the db row to the rendered block", async () => {
	const { UIFormatter } = await import("../src/ui/UIFormatter.js")
	db.getOrCreateUser(61)
	db.upsertVideo("link1", "yt:@linkchan", "vidLink1", "видео со ссылкой",
		"https://www.youtube.com/watch?v=vidLink1", 100, 600, new Date(Date.now() - 86400_000).toISOString())

	const candidates = db.getVideoCandidates(7, new Set(), 61).filter((v) => v.id === "link1")
	assert.equal(candidates.length, 1)

	const postById = UIFormatter.buildPostById(candidates)
	assert.ok(postById.link1.postUrl.startsWith("https://www.youtube.com/watch"),
		`a video must keep its own url, got ${postById.link1.postUrl}`)

	const text = UIFormatter.formatVideoBlockText({ ids: ["link1"], essence: "суть", emoji: "🎬" }, postById)
	assert.ok(!text.includes("t.me"), "no fabricated telegram link reaches the message")
})

test("the tail send offers no further button", async () => {
	const sends = []
	const telegram = {
		sendMessage: async (chatId, text, extra) => { sends.push({ text, extra }); return { message_id: sends.length } }
	}

	const videos = [
		{ id: "tail1", channel: "yt:@tailchan", post_id: "tv1", source: "yt", link: "https://www.youtube.com/watch?v=tv1", date: "2026-08-01T00:00:00.000Z", duration_sec: 600, views: 10 }
	]
	const service = {
		selectVideosForDigest: async () => ({ videos, remaining: 5, reasonById: new Map() }),
		mgr: { ai: { generateSummaryBlocks: async () => ({ blocks: [{ ids: ["tail1"], essence: "e", emoji: "🎬" }] }) } },
		sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
	}
	db.getOrCreateUser(62)

	await service.sendVideoSection.call(service, telegram, 62, { withHeader: false, withMore: false })
	assert.equal(sends.length, 1, "only the video block goes out")
	assert.ok(!sends.some((s) => JSON.stringify(s.extra || {}).includes("video_more")),
		"the tail must not re-render the more button")
})

test("the lead send still offers the tail button", async () => {
	const sends = []
	const telegram = {
		sendMessage: async (chatId, text, extra) => { sends.push({ text, extra }); return { message_id: sends.length } }
	}

	const videos = [
		{ id: "lead1", channel: "yt:@leadchan", post_id: "lv1", source: "yt", link: "https://www.youtube.com/watch?v=lv1", date: "2026-08-01T00:00:00.000Z", duration_sec: 600, views: 10 }
	]
	const service = {
		selectVideosForDigest: async () => ({ videos, remaining: 5, reasonById: new Map() }),
		mgr: { ai: { generateSummaryBlocks: async () => ({ blocks: [{ ids: ["lead1"], essence: "e", emoji: "🎬" }] }) } },
		sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
	}
	db.getOrCreateUser(63)

	await service.sendVideoSection.call(service, telegram, 63, { withHeader: false })
	assert.ok(sends.some((s) => JSON.stringify(s.extra || {}).includes("video_more")), "the lead send carries the button")
})

test("video ranking gets the same signal as the text path", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 64
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))
	db.upsertVideo("sig1", "yt:@sigchan", "sigv1", "видео про рынок", "https://www.youtube.com/watch?v=sigv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.setUserChannelPriority(userId, "yt:@sigchan", 2)
	db.upsertPostFeedback(userId, "sig1", 1)

	let seenOpts = null
	const service = new BotService({
		ai: {
			rankPosts: async (posts, profile, opts) => {
				seenOpts = opts
				return posts.map((p) => ({ post_id: p.id, score: 1, reason: "потому что" }))
			}
		}
	})
	const result = await service.selectVideosForDigest(userId)

	assert.ok(seenOpts, "options are passed at all")
	assert.ok(seenOpts.channelPriorities, "channel priorities reach the video ranking")
	assert.ok(seenOpts.feedback, "feedback reaches the video ranking")
	assert.ok("systemPrompt" in seenOpts, "the system prompt reaches the video ranking")
	assert.equal(result.reasonById.get("sig1"), "потому что", "the reason is kept so 📌 Почему can render")
})

test("a minus-keyword drops a video before it is ranked", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 65
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))
	db.upsertVideo("mk1", "yt:@mkchan", "mkv1", "обзор крипты на неделю", "https://www.youtube.com/watch?v=mkv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.updateUserMinusKeywords(userId, "крипт")

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 1 })) }
	})
	const result = await service.selectVideosForDigest(userId)
	assert.ok(!result.videos.some((v) => v.id === "mk1"), "a minus-keyword filters videos as it filters posts")
})

test("a ranked video block carries the why button", async () => {
	const sends = []
	const telegram = {
		sendMessage: async (chatId, text, extra) => { sends.push({ text, extra }); return { message_id: sends.length } }
	}

	const videos = [
		{ id: "why1", channel: "yt:@whychan", post_id: "wv1", source: "yt", link: "https://www.youtube.com/watch?v=wv1", date: "2026-08-01T00:00:00.000Z", duration_sec: 600, views: 10 }
	]
	const service = {
		selectVideosForDigest: async () => ({ videos, remaining: 0, reasonById: new Map([["why1", "совпадает с профилем"]]) }),
		mgr: {
			cache: { setBlock: () => {} },
			ai: { generateSummaryBlocks: async () => ({ blocks: [{ ids: ["why1"], essence: "e", emoji: "🎬" }] }) }
		},
		sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
	}
	db.getOrCreateUser(66)

	await service.sendVideoSection.call(service, telegram, 66, { withHeader: false })
	assert.ok(JSON.stringify(sends[0].extra).includes("why:why1"), "📌 Почему is offered on a video with a reason")
})

test("a channel with three eligible videos yields the most-viewed and the longest", () => {
	const userId = 70
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("cap-low", "yt:@capcap", "capv-low", "видео", "https://youtube.com/watch?v=capv-low", 100, 400,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("cap-high-views", "yt:@capcap", "capv-high-views", "видео", "https://youtube.com/watch?v=capv-high-views", 900, 500,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("cap-longest", "yt:@capcap", "capv-longest", "видео", "https://youtube.com/watch?v=capv-longest", 300, 4200,
		new Date(Date.now() - 86400_000).toISOString())

	const candidates = db.getVideoCandidates(7, new Set(), userId)
	const fromChannel = candidates.filter((v) => v.channel === "yt:@capcap")
	assert.equal(fromChannel.length, 2, "at most two videos per channel")
	assert.ok(fromChannel.some((v) => v.id === "cap-high-views"), "the most-viewed video is one of them")
	assert.ok(fromChannel.some((v) => v.id === "cap-longest"), "the longest video is the other")
	assert.ok(!fromChannel.some((v) => v.id === "cap-low"), "the video that is neither is dropped")
})

test("a channel whose most-viewed video is also its longest contributes only one row", () => {
	const userId = 75
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("same-winner", "yt:@samewinchan", "samewinv1", "видео", "https://youtube.com/watch?v=samewinv1", 900, 4200,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("same-other", "yt:@samewinchan", "samewinv2", "видео", "https://youtube.com/watch?v=samewinv2", 300, 400,
		new Date(Date.now() - 86400_000).toISOString())

	const candidates = db.getVideoCandidates(7, new Set(), userId)
	const fromChannel = candidates.filter((v) => v.channel === "yt:@samewinchan")
	assert.equal(fromChannel.length, 1, "the same video winning both slots is not duplicated")
	assert.equal(fromChannel[0].id, "same-winner")
})

test("a channel whose videos are all under the minimum duration contributes nothing", () => {
	const userId = 76
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("allshort-top", "yt:@allshortchan", "allshortv1", "видео", "https://youtube.com/watch?v=allshortv1", 900, 200,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("allshort-other", "yt:@allshortchan", "allshortv2", "видео", "https://youtube.com/watch?v=allshortv2", 300, 100,
		new Date(Date.now() - 86400_000).toISOString())

	const candidates = db.getVideoCandidates(7, new Set(), userId)
	assert.ok(!candidates.some((v) => v.channel === "yt:@allshortchan"),
		"even the channel's most-viewed video is excluded once it is too short")
})

test("the per-channel cap does not remove videos from other channels", () => {
	const userId = 71
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("multi-a", "yt:@multia", "multiv-a", "видео", "https://youtube.com/watch?v=multiv-a", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("multi-b", "yt:@multib", "multiv-b", "видео", "https://youtube.com/watch?v=multiv-b", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())

	const candidates = db.getVideoCandidates(7, new Set(), userId)
	assert.ok(candidates.some((v) => v.id === "multi-a"), "channel A's video is kept")
	assert.ok(candidates.some((v) => v.id === "multi-b"), "channel B's video is kept")
})

test("a video shorter than the minimum duration is dropped, a longer one is kept", () => {
	const userId = 72
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("short1", "yt:@shortchan", "shortv1", "видео", "https://youtube.com/watch?v=shortv1", 100, 200,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("long1", "yt:@longchan", "longv1", "видео", "https://youtube.com/watch?v=longv1", 100, 400,
		new Date(Date.now() - 86400_000).toISOString())

	const candidates = db.getVideoCandidates(7, new Set(), userId)
	assert.ok(!candidates.some((v) => v.id === "short1"), "a 200-second video is too short")
	assert.ok(candidates.some((v) => v.id === "long1"), "a 400-second video is kept")
})

test("a video with unknown duration is kept, not dropped", () => {
	const userId = 73
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("nulldur1", "yt:@nulldurchan", "nulldurv1", "видео", "https://youtube.com/watch?v=nulldurv1", 100, null,
		new Date(Date.now() - 86400_000).toISOString())

	const candidates = db.getVideoCandidates(7, new Set(), userId)
	assert.ok(candidates.some((v) => v.id === "nulldur1"), "a missing duration must not be treated as a short video")
})

test("NULL duration wins the longest slot only when nothing else on the channel is longer", () => {
	const userId = 77
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	// alone on its channel: NULL duration is the only candidate, so it must win the longest slot
	db.upsertVideo("nulldur-alone", "yt:@nulldural", "nulldurv3", "видео", "https://youtube.com/watch?v=nulldurv3", 100, null,
		new Date(Date.now() - 86400_000).toISOString())
	const alone = db.getVideoCandidates(7, new Set(), userId).filter((v) => v.channel === "yt:@nulldural")
	assert.equal(alone.length, 1)
	assert.equal(alone[0].id, "nulldur-alone", "with no competing duration, NULL still wins the only slot available")

	// alongside a video with a known, longer duration: SQLite sorts NULL last in ORDER BY duration_sec DESC,
	// so the known-duration video takes the longest slot and the NULL-duration one only survives via views
	db.upsertVideo("nulldur-vs-known-null", "yt:@nulldurvs", "nulldurv4", "видео", "https://youtube.com/watch?v=nulldurv4", 900, null,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("nulldur-vs-known-long", "yt:@nulldurvs", "nulldurv5", "видео", "https://youtube.com/watch?v=nulldurv5", 100, 4200,
		new Date(Date.now() - 86400_000).toISOString())
	const versus = db.getVideoCandidates(7, new Set(), userId).filter((v) => v.channel === "yt:@nulldurvs")
	assert.equal(versus.length, 2, "both survive: NULL one via views, the other via duration")
	assert.ok(versus.some((v) => v.id === "nulldur-vs-known-null"), "the NULL-duration video wins via views, not duration")
	assert.ok(versus.some((v) => v.id === "nulldur-vs-known-long"), "the known-duration video takes the longest slot")
})

test("leads are diversified by topic instead of taking the two highest scores", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 80
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	const items = [
		{ id: "div-a1", topic: "AI", score: 0.95 },
		{ id: "div-a2", topic: "AI", score: 0.9 },
		{ id: "div-a3", topic: "AI", score: 0.85 },
		{ id: "div-b1", topic: "политика", score: 0.5 },
		{ id: "div-c1", topic: "здоровье", score: 0.4 }
	]
	for (const it of items) {
		db.upsertVideo(it.id, `yt:@divchan-${it.id}`, it.id, "видео", `https://youtube.com/watch?v=${it.id}`, 100, 600,
			new Date(Date.now() - 86400_000).toISOString())
	}

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => {
			const it = items.find((i) => i.id === p.id)
			return { post_id: p.id, score: it.score, topic: it.topic }
		}) }
	})
	const result = await service.selectVideosForDigest(userId)
	const topics = result.videos.map((v) => items.find((i) => i.id === v.id).topic)
	assert.equal(new Set(topics).size, topics.length, "no two leads share a topic")
	assert.ok(topics.includes("политика"), "a lower-scoring but distinct topic must be picked over a same-topic duplicate")
	assert.ok(topics.includes("здоровье"))
})

test("when every candidate shares one topic, the lead is still filled to the limit", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 81
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	const ids = ["mono1", "mono2", "mono3", "mono4"]
	for (const id of ids) {
		db.upsertVideo(id, `yt:@monochan-${id}`, id, "видео", `https://youtube.com/watch?v=${id}`, 100, 600,
			new Date(Date.now() - 86400_000).toISOString())
	}

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 1, topic: "один и тот же" })) }
	})
	const result = await service.selectVideosForDigest(userId)
	assert.equal(result.videos.length, 3, "diversity must not shrink the section when topics are not available")
})

test("items missing a topic field do not break selection", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 82
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	const ids = ["notopic1", "notopic2", "notopic3"]
	for (const id of ids) {
		db.upsertVideo(id, `yt:@notopicchan-${id}`, id, "видео", `https://youtube.com/watch?v=${id}`, 100, 600,
			new Date(Date.now() - 86400_000).toISOString())
	}

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 1 })) }
	})
	const result = await service.selectVideosForDigest(userId)
	assert.equal(result.videos.length, 3, "missing topics still fill the lead")
})

test("pressing the tail repeatedly never exceeds the daily cap of 30", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 300
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	for (let i = 0; i < 40; i++) {
		db.upsertVideo(`d30-${i}`, `yt:@d30chan${i}`, `d30v${i}`, `видео ${i}`, `https://youtube.com/watch?v=d30-${i}`, 100, 600,
			new Date(Date.now() - 86400_000).toISOString())
	}

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 1 })) }
	})

	let total = 0
	let result = await service.selectVideosForDigest(userId, { limit: 3 })
	db.markDigestShown(userId, result.videos.map((v) => v.id))
	total += result.videos.length

	while (result.remaining > 0) {
		result = await service.selectVideosForDigest(userId, { limit: 7 })
		db.markDigestShown(userId, result.videos.map((v) => v.id))
		total += result.videos.length
	}

	assert.equal(total, 30, "3 + 7 + 7 + 7 + 6 = 30, never more")
})

test("the button renders after a tail send while videos remain, and disappears once the cap of 30 is exhausted", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 301
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	for (let i = 0; i < 40; i++) {
		db.upsertVideo(`btn-${i}`, `yt:@btnchan${i}`, `btnv${i}`, `видео ${i}`, `https://youtube.com/watch?v=btn-${i}`, 100, 600,
			new Date(Date.now() - 86400_000).toISOString())
	}

	const sends = []
	const telegram = { sendMessage: async (chatId, text, extra) => { sends.push({ text, extra }); return { message_id: sends.length } } }
	const service = new BotService({
		ai: {
			rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 1 })),
			generateSummaryBlocks: async (videos) => ({ blocks: videos.map((v) => ({ ids: [v.id], essence: "e", emoji: "🎬" })) })
		}
	})
	const hasMoreButton = () => sends.some((s) => JSON.stringify(s.extra || {}).includes("video_more"))

	await service.sendVideoSection(telegram, userId, { limit: 3 })
	assert.ok(hasMoreButton(), "the lead send offers the tail button")

	sends.length = 0
	await service.sendVideoSection(telegram, userId, { limit: 7, withHeader: false })
	assert.ok(hasMoreButton(), "a tail send with videos still remaining offers another tail button")

	sends.length = 0
	await service.sendVideoSection(telegram, userId, { limit: 7, withHeader: false })
	sends.length = 0
	await service.sendVideoSection(telegram, userId, { limit: 7, withHeader: false })
	sends.length = 0
	await service.sendVideoSection(telegram, userId, { limit: 7, withHeader: false })
	assert.ok(!hasMoreButton(), "once the cap of 30 is reached, no more button is offered")
})

test("a second selectVideosForDigest call for the same user and date reuses the persisted ranking instead of re-ranking", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 302
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("pr1", "yt:@prchan1", "prv1", "видео 1", "https://youtube.com/watch?v=prv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("pr2", "yt:@prchan2", "prv2", "видео 2", "https://youtube.com/watch?v=prv2", 200, 600,
		new Date(Date.now() - 86400_000).toISOString())

	let rankCalls = 0
	const service = new BotService({
		ai: { rankPosts: async (posts) => { rankCalls += 1; return posts.map((p) => ({ post_id: p.id, score: 1 })) } }
	})

	const first = await service.selectVideosForDigest(userId, { limit: 10 })
	const second = await service.selectVideosForDigest(userId, { limit: 10 })

	assert.equal(rankCalls, 1, "the second call must not re-rank")
	assert.deepEqual(second.videos.map((v) => v.id).sort(), first.videos.map((v) => v.id).sort(),
		"the candidates returned are consistent between calls")
})

test("the persisted ranking survives a fresh BotService instance, proving it lives in the db, not memory", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 303
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("fresh-svc1", "yt:@freshsvcchan", "fsv1", "видео", "https://youtube.com/watch?v=fsv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())

	let rankCalls = 0
	const rankStub = { rankPosts: async (posts) => { rankCalls += 1; return posts.map((p) => ({ post_id: p.id, score: 1 })) } }

	const first = new BotService({ ai: rankStub })
	await first.selectVideosForDigest(userId, { limit: 10 })

	const second = new BotService({ ai: rankStub })
	const result = await second.selectVideosForDigest(userId, { limit: 10 })

	assert.equal(rankCalls, 1, "a brand-new service instance still reads the persisted ranking")
	assert.ok(result.videos.some((v) => v.id === "fresh-svc1"))
})

test("a different digest date re-ranks instead of reusing yesterday's persisted ranking", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 304
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("dt-1", "yt:@dtchan1", "dtv1", "видео", "https://youtube.com/watch?v=dtv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())

	let rankCalls = 0
	const service = new BotService({
		ai: { rankPosts: async (posts) => { rankCalls += 1; return posts.map((p) => ({ post_id: p.id, score: 1 })) } }
	})

	await service.selectVideosForDigest(userId, { limit: 10 })
	assert.equal(rankCalls, 1)

	service.digestDate = () => "1999-01-01"
	await service.selectVideosForDigest(userId, { limit: 10 })
	assert.equal(rankCalls, 2, "a different date has no persisted ranking yet, so it re-ranks")
})

test("a video's topic round-trips through the rankings table", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 305
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("topic-rt1", "yt:@topicrtchan", "trv1", "видео", "https://youtube.com/watch?v=trv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 1, topic: "технологии" })) }
	})
	await service.selectVideosForDigest(userId, { limit: 10 })

	const date = service.digestDate()
	const row = db.getVideoRankingRows(userId, date).find((r) => r.post_id === "topic-rt1")
	assert.ok(row, "the video's ranking row is persisted")
	assert.equal(row.topic, "технологии", "the topic survives the round trip through rankings")
})

test("ensureRankingsForDate re-ranking text posts does not delete that day's video rankings", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 306
	const date = "2026-01-18"
	db.getOrCreateUser(userId)

	db.upsertPost("txt-er1", "erchan", 1, "текст", "https://t.me/erchan/1", 5, `${date}T10:00:00.000Z`)
	db.upsertVideo("vid-er1", "yt:@ervidchan", "erv1", "видео", "https://youtube.com/watch?v=erv1", 100, 600, `${date}T09:00:00.000Z`)
	db.insertRankings(userId, date, [{ id: "r-vid-er1", post_id: "vid-er1", score: 0.9, reason: "video", topic: "видео" }])

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 0.7, reason: "text reason" })) }
	})
	await service.ensureRankingsForDate(userId, date, "")

	assert.ok(db.getRankedPostIds(userId, date, 10).includes("txt-er1"), "the text digest got ranked")
	assert.ok(db.getVideoRankingRows(userId, date).some((r) => r.post_id === "vid-er1"),
		"the pre-existing video ranking for the same day survives the text re-rank")
})

test("writing a fresh video ranking does not disturb an existing text ranking for the same day", async () => {
	const { BotService } = await import("../src/services/BotService.js")
	const userId = 307
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("vid-wr1", "yt:@wrvidchan", "wrv1", "видео", "https://youtube.com/watch?v=wrv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 1, topic: "т" })) }
	})
	const date = service.digestDate()
	db.upsertPost("txt-wr1", "wrchan", 1, "текст существующий", "https://t.me/wrchan/1", 5, `${date}T10:00:00.000Z`)
	db.insertRankings(userId, date, [{ id: "r-txt-wr1", post_id: "txt-wr1", score: 0.5, reason: "existing text" }])

	await service.selectVideosForDigest(userId, { limit: 10 })

	assert.ok(db.getRankedPostIds(userId, date, 10).includes("txt-wr1"),
		"the existing text ranking for the day is untouched by writing the video ranking")
})

test("both the most-viewed and the longest picks are stable across repeated calls when tied", () => {
	const userId = 74
	db.getOrCreateUser(userId)
	db.markDigestShown(userId, db.getVideoCandidates(7, new Set()).map((v) => v.id))

	db.upsertVideo("tie-a", "yt:@tiechan", "tiev-a", "видео", "https://youtube.com/watch?v=tiev-a", 500, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("tie-b", "yt:@tiechan", "tiev-b", "видео", "https://youtube.com/watch?v=tiev-b", 500, 600,
		new Date(Date.now() - 86400_000).toISOString())

	const first = db.getVideoCandidates(7, new Set(), userId).filter((v) => v.channel === "yt:@tiechan").map((v) => v.id).sort()
	const second = db.getVideoCandidates(7, new Set(), userId).filter((v) => v.channel === "yt:@tiechan").map((v) => v.id).sort()
	assert.deepEqual(first, second, "the same tie-break winners are returned on repeated calls")
	assert.equal(first.length, 1, "a full tie on both views and duration still collapses to one row")
})

test("pruneOldVideoRankings deletes video rankings older than the cutoff", () => {
	const userId = 91
	db.getOrCreateUser(userId)

	db.upsertVideo("prune-old-v1", "yt:@prunechan", "pruneold1", "видео", "https://youtube.com/watch?v=pruneold1", 100, 600,
		new Date(Date.now() - 10 * 86400_000).toISOString())

	db.insertRankings(userId, "2020-01-01", [{ id: "r-prune-old1", post_id: "prune-old-v1", score: 1, reason: "old" }])

	const deleted = db.pruneOldVideoRankings("2020-06-01")
	assert.ok(deleted >= 1, "at least the seeded stale row was deleted")

	const row = db.default.prepare("SELECT id FROM rankings WHERE id = ?").get("r-prune-old1")
	assert.equal(row, undefined, "the stale video ranking is gone")
})

test("pruneOldVideoRankings leaves video rankings inside the cutoff untouched", () => {
	const userId = 92
	db.getOrCreateUser(userId)

	db.upsertVideo("prune-fresh-v1", "yt:@prunechan2", "prunefresh1", "видео", "https://youtube.com/watch?v=prunefresh1", 100, 600,
		new Date(Date.now() - 2 * 86400_000).toISOString())

	db.insertRankings(userId, "2026-08-29", [{ id: "r-prune-fresh1", post_id: "prune-fresh-v1", score: 1, reason: "fresh" }])

	db.pruneOldVideoRankings("2026-08-27")

	const row = db.default.prepare("SELECT id FROM rankings WHERE id = ?").get("r-prune-fresh1")
	assert.ok(row, "the fresh video ranking survives")
})

test("pruneOldVideoRankings never touches text-post rankings, regardless of age", () => {
	const userId = 93
	db.getOrCreateUser(userId)

	db.upsertPost("prune-old-tg1", "prunetgchan", 999, "текст", "https://t.me/prunetgchan/999", 5, "2020-01-01T10:00:00.000Z")
	db.insertRankings(userId, "2020-01-01", [{ id: "r-prune-old-tg1", post_id: "prune-old-tg1", score: 1, reason: "old text" }])

	db.pruneOldVideoRankings("2026-08-29")

	const row = db.default.prepare("SELECT id FROM rankings WHERE id = ?").get("r-prune-old-tg1")
	assert.ok(row, "a text ranking of any age is untouched — videos only")
})

test("the tail button promises what one press delivers, not the whole backlog", async () => {
	const { KeyboardProvider } = await import("../src/ui/KeyboardProvider.js")
	const { VIDEO_TAIL_COUNT } = await import("../src/services/BotService.js")

	const many = KeyboardProvider.videoMoreKeyboard(23, VIDEO_TAIL_COUNT)
	assert.match(
		many.reply_markup.inline_keyboard[0][0].text,
		new RegExp(`Ещё ${VIDEO_TAIL_COUNT} видео`),
		"a large backlog still offers one batch, since that is what the press sends"
	)

	const few = KeyboardProvider.videoMoreKeyboard(2, VIDEO_TAIL_COUNT)
	assert.match(few.reply_markup.inline_keyboard[0][0].text, /Ещё 2 видео/, "a short tail says its real size")

	assert.equal(KeyboardProvider.videoMoreKeyboard(0, VIDEO_TAIL_COUNT), undefined)
})

test("a liked video appears in /liked, a liked telegram post does not", () => {
	const userId = 400
	db.getOrCreateUser(userId)

	db.upsertVideo("liked-vid1", "yt:@likedchan", "likedv1", "заголовок видео", "https://youtube.com/watch?v=likedv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertPost("liked-post1", "likedtgchan", 1, "текст поста", "https://t.me/likedtgchan/1", 5, "2026-08-29T10:00:00.000Z")

	db.upsertPostFeedback(userId, "liked-vid1", 1)
	db.upsertPostFeedback(userId, "liked-post1", 1)

	const rows = db.getLikedUnwatchedVideos(userId, 10)
	assert.ok(rows.some((r) => r.id === "liked-vid1"), "the liked video is in the list")
	assert.ok(!rows.some((r) => r.id === "liked-post1"), "a liked telegram post never appears")
})

test("marking a video watched drops it out of the liked list", () => {
	const userId = 401
	db.getOrCreateUser(userId)

	db.upsertVideo("watched-vid1", "yt:@watchedchan", "watchedv1", "заголовок", "https://youtube.com/watch?v=watchedv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertPostFeedback(userId, "watched-vid1", 1)

	assert.ok(db.getLikedUnwatchedVideos(userId, 10).some((r) => r.id === "watched-vid1"))

	const marked = db.markVideoWatched(userId, "watched-vid1")
	assert.ok(marked, "the update touched a row")
	assert.ok(!db.getLikedUnwatchedVideos(userId, 10).some((r) => r.id === "watched-vid1"),
		"a watched video no longer appears")
})

test("a like changed to a dislike drops out of the liked list", () => {
	const userId = 402
	db.getOrCreateUser(userId)

	db.upsertVideo("flip-vid1", "yt:@flipchan", "flipv1", "заголовок", "https://youtube.com/watch?v=flipv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertPostFeedback(userId, "flip-vid1", 1)
	assert.ok(db.getLikedUnwatchedVideos(userId, 10).some((r) => r.id === "flip-vid1"))

	db.upsertPostFeedback(userId, "flip-vid1", -1)
	assert.ok(!db.getLikedUnwatchedVideos(userId, 10).some((r) => r.id === "flip-vid1"),
		"a rating flipped to dislike drops the video from the liked list")
})

test("marking a video watched leaves its rating intact for ranking personalization", () => {
	const userId = 403
	db.getOrCreateUser(userId)

	db.upsertVideo("keep-rating-vid1", "yt:@keepratingchan", "keepratingv1", "заголовок", "https://youtube.com/watch?v=keepratingv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertPostFeedback(userId, "keep-rating-vid1", 1)
	db.markVideoWatched(userId, "keep-rating-vid1")

	const row = db.default.prepare("SELECT rating, watched_at FROM post_feedback WHERE user_id = ? AND post_id = ?")
		.get(userId, "keep-rating-vid1")
	assert.equal(row.rating, 1, "rating is untouched")
	assert.ok(row.watched_at, "watched_at is set")
})

test("the /liked cap reports the remainder honestly", () => {
	const userId = 404
	db.getOrCreateUser(userId)

	for (let i = 0; i < 13; i++) {
		db.upsertVideo(`cap-liked-${i}`, `yt:@capliked${i}`, `capvid${i}`, `заголовок ${i}`, `https://youtube.com/watch?v=capliked${i}`, 100, 600,
			new Date(Date.now() - 86400_000).toISOString())
		db.upsertPostFeedback(userId, `cap-liked-${i}`, 1)
	}

	const total = db.countLikedUnwatchedVideos(userId)
	assert.equal(total, 13)

	const rows = db.getLikedUnwatchedVideos(userId, 10)
	assert.equal(rows.length, 10, "the list itself is capped at 10")

	const remaining = total - rows.length
	assert.equal(remaining, 3, "the honest remainder outside the cap")
})

test("marking watched swaps the keyboard for an inert button and never rewrites the message text", async () => {
	const { ActionHandler } = await import("../src/handlers/ActionHandler.js")
	const userId = 405
	db.getOrCreateUser(userId)
	db.upsertVideo("noop-vid1", "yt:@noopchan", "noopv1", "заголовок", "https://youtube.com/watch?v=noopv1", 100, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertPostFeedback(userId, "noop-vid1", 1)

	const action = new ActionHandler({})
	let textEdited = false
	let newMarkup = null
	const ctx = {
		match: [null, "noop-vid1"],
		from: { id: userId },
		answerCbQuery: async () => {},
		editMessageText: async () => { textEdited = true },
		editMessageReplyMarkup: async (markup) => { newMarkup = markup }
	}

	await action.handleVideoWatched(ctx)

	assert.equal(textEdited, false, "the message text — and its link — is never touched")
	assert.ok(newMarkup, "the keyboard is replaced")
	assert.match(JSON.stringify(newMarkup), /Посмотрено/, "the button reads as done")

	const row = db.default.prepare("SELECT rating, watched_at FROM post_feedback WHERE user_id = ? AND post_id = ?")
		.get(userId, "noop-vid1")
	assert.equal(row.rating, 1, "rating is still untouched")
	assert.ok(row.watched_at, "watched_at is still stamped")
})

test("a failure selecting videos alerts the admin and still returns 0 without throwing", async () => {
	const prevAdmin = process.env.ADMIN_ID
	process.env.ADMIN_ID = "999"
	try {
		const sent = []
		const telegram = {
			sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length } }
		}
		const service = {
			selectVideosForDigest: async () => { throw new Error("AI down") },
			sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
		}

		let count
		await assert.doesNotReject(async () => {
			count = await service.sendVideoSection.call(service, telegram, 900, {})
		})
		assert.equal(count, 0)
		assert.equal(sent.length, 1, "the admin got exactly one alert")
		assert.equal(sent[0].chatId, 999)
		assert.match(sent[0].text, /AI down/)
	} finally {
		if (prevAdmin === undefined) delete process.env.ADMIN_ID
		else process.env.ADMIN_ID = prevAdmin
	}
})

test("a failure generating blocks alerts the admin and still returns 0 without throwing", async () => {
	const prevAdmin = process.env.ADMIN_ID
	process.env.ADMIN_ID = "999"
	try {
		const sent = []
		const telegram = {
			sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length } }
		}
		db.getOrCreateUser(901)
		const videos = [
			{ id: "bf1", channel: "yt:@bfchan", post_id: "bf1", link: null, date: "2026-08-01T00:00:00.000Z", duration_sec: 100, views: 10 }
		]
		const service = {
			selectVideosForDigest: async () => ({ videos, remaining: 0 }),
			mgr: { ai: { generateSummaryBlocks: async () => { throw new Error("provider exhausted") } } },
			sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
		}

		let count
		await assert.doesNotReject(async () => {
			count = await service.sendVideoSection.call(service, telegram, 901, {})
		})
		assert.equal(count, 0)
		assert.equal(sent.length, 1)
		assert.equal(sent[0].chatId, 999)
		assert.match(sent[0].text, /provider exhausted/)
	} finally {
		if (prevAdmin === undefined) delete process.env.ADMIN_ID
		else process.env.ADMIN_ID = prevAdmin
	}
})

test("a send failure alerts the admin in addition to leaving the delivered videos marked shown", async () => {
	const prevAdmin = process.env.ADMIN_ID
	process.env.ADMIN_ID = "999"
	try {
		db.getOrCreateUser(902)
		const videos = [
			{ id: "sf1", channel: "yt:@sfchan", post_id: "sf1", link: null, date: "2026-08-01T00:00:00.000Z", duration_sec: 100, views: 10 }
		]
		const sent = []
		const telegram = {
			sendMessage: async (chatId, text) => {
				sent.push({ chatId, text })
				if (chatId === 902) throw new Error("Telegram rejected the message")
				return { message_id: sent.length }
			}
		}
		const service = {
			selectVideosForDigest: async () => ({ videos, remaining: 0 }),
			mgr: { ai: { generateSummaryBlocks: async () => ({ blocks: [{ ids: ["sf1"], essence: "e", emoji: "🎬" }] }) } },
			sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
		}

		let count
		await assert.doesNotReject(async () => {
			count = await service.sendVideoSection.call(service, telegram, 902, { withHeader: false })
		})
		assert.equal(count, 0)
		const adminAlerts = sent.filter((s) => s.chatId === 999)
		assert.equal(adminAlerts.length, 1)
		assert.match(adminAlerts[0].text, /Telegram rejected the message/)
	} finally {
		if (prevAdmin === undefined) delete process.env.ADMIN_ID
		else process.env.ADMIN_ID = prevAdmin
	}
})

test("an admin alert that itself fails does not make sendVideoSection throw", async () => {
	const prevAdmin = process.env.ADMIN_ID
	process.env.ADMIN_ID = "999"
	try {
		const telegram = {
			sendMessage: async () => { throw new Error("admin chat is blocked") }
		}
		const service = {
			selectVideosForDigest: async () => { throw new Error("AI down") },
			sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
		}

		let count
		await assert.doesNotReject(async () => {
			count = await service.sendVideoSection.call(service, telegram, 903, {})
		})
		assert.equal(count, 0, "still reports nothing sent despite the alert itself failing")
	} finally {
		if (prevAdmin === undefined) delete process.env.ADMIN_ID
		else process.env.ADMIN_ID = prevAdmin
	}
})

test("no ADMIN_ID means no alert attempt and no error", async () => {
	const prevAdmin = process.env.ADMIN_ID
	delete process.env.ADMIN_ID
	try {
		const sent = []
		const telegram = {
			sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length } }
		}
		const service = {
			selectVideosForDigest: async () => { throw new Error("AI down") },
			sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
		}

		let count
		await assert.doesNotReject(async () => {
			count = await service.sendVideoSection.call(service, telegram, 904, {})
		})
		assert.equal(count, 0)
		assert.equal(sent.length, 0, "no alert is attempted without an ADMIN_ID")
	} finally {
		if (prevAdmin === undefined) delete process.env.ADMIN_ID
		else process.env.ADMIN_ID = prevAdmin
	}
})

test("the happy path sends no admin alert", async () => {
	const prevAdmin = process.env.ADMIN_ID
	process.env.ADMIN_ID = "999"
	try {
		db.getOrCreateUser(905)
		const sends = []
		const telegram = { sendMessage: async (chatId, text, extra) => { sends.push({ chatId, text, extra }); return { message_id: sends.length } } }
		const videos = [
			{ id: "hp1", channel: "yt:@hpchan", post_id: "hpv1", source: "yt", link: "https://www.youtube.com/watch?v=hpv1", date: "2026-08-01T00:00:00.000Z", duration_sec: 600, views: 10 }
		]
		const service = {
			selectVideosForDigest: async () => ({ videos, remaining: 0, reasonById: new Map() }),
			mgr: { ai: { generateSummaryBlocks: async () => ({ blocks: [{ ids: ["hp1"], essence: "e", emoji: "🎬" }] }) } },
			sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
		}

		const count = await service.sendVideoSection.call(service, telegram, 905, { withHeader: false })
		assert.ok(count > 0, "the happy path actually sends something")
		assert.ok(!sends.some((s) => s.chatId === 999), "no admin alert on the happy path")
	} finally {
		if (prevAdmin === undefined) delete process.env.ADMIN_ID
		else process.env.ADMIN_ID = prevAdmin
	}
})
