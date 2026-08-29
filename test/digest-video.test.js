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

	for (let i = 0; i < 12; i++) {
		db.upsertVideo(`cap${i}`, `yt:@capchan${i}`, `capvid${i}`, `видео ${i}`, `https://youtube.com/watch?v=cap${i}`, 100, 600,
			new Date(Date.now() - 86400_000).toISOString())
	}

	const service = new BotService({
		ai: { rankPosts: async (posts) => posts.map((p) => ({ post_id: p.id, score: 1 })) }
	})
	const result = await service.selectVideosForDigest(userId)
	assert.equal(result.videos.length, 3, "lead count is 3")
	assert.equal(result.remaining, 7, "cap 10 minus lead 3")
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
