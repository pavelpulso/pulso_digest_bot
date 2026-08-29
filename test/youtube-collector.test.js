import { test } from "node:test"
import assert from "node:assert/strict"

process.env.DB_PATH = ":memory:"
const db = await import("../src/db.js")
const { collectYouTubeVideos, backfillChannelActivity } = await import("../src/youtube/collector.js")
const { QuotaExceededError } = await import("../src/youtube/client.js")

function fakeClient(overrides = {}) {
	return {
		isReady: () => true,
		listSubscriptions: async () => [{ channelId: "UC1", title: "@chan1" }],
		listVideoDetails: async (ids) => ids.map((id) => ({
			videoId: id,
			title: "Заголовок",
			description: "Описание",
			channelTitle: "@chan1",
			publishedAt: "2026-08-29T08:00:00Z",
			views: 5000,
			durationSec: 600
		})),
		...overrides
	}
}

function fakeFetchFeeds(videosByChannelId = {}, errorsByChannelId = {}) {
	return async (channelIds) => {
		const byChannel = new Map()
		const errors = []
		for (const id of channelIds) {
			if (errorsByChannelId[id]) {
				errors.push({ channelId: id, message: errorsByChannelId[id] })
			} else {
				byChannel.set(id, videosByChannelId[id] || [{ videoId: "vid1", publishedAt: "2026-08-29T08:00:00Z" }])
			}
		}
		return { byChannel, errors }
	}
}

test("a collected video lands in posts as a yt-source row", async () => {
	const result = await collectYouTubeVideos({
		client: fakeClient(),
		fetchFeeds: fakeFetchFeeds(),
		now: new Date("2026-08-29T12:00:00Z")
	})

	assert.equal(result.collected, 1)
	assert.deepEqual(result.errors, [])

	const stored = db.getVideosInWindow("2026-08-22T12:00:00.000Z")
	assert.equal(stored.length, 1)
	assert.equal(stored[0].source, "yt")
	assert.equal(stored[0].post_id, "vid1")
	assert.equal(stored[0].duration_sec, 600)
	assert.match(stored[0].link, /vid1/)
})

test("shorts are dropped, streams are kept", async () => {
	const client = fakeClient({
		listVideoDetails: async (ids) => ids.map((id) => ({
			videoId: id,
			title: "t",
			description: "d",
			channelTitle: "@chan1",
			publishedAt: "2026-08-29T08:00:00Z",
			views: 100,
			durationSec: id === "short1" ? 45 : 7200
		}))
	})
	const fetchFeeds = fakeFetchFeeds({
		UC1: [
			{ videoId: "short1", publishedAt: "2026-08-29T08:00:00Z" },
			{ videoId: "long1", publishedAt: "2026-08-29T08:00:00Z" }
		]
	})

	const result = await collectYouTubeVideos({ client, fetchFeeds, now: new Date("2026-08-29T12:00:00Z") })
	assert.equal(result.collected, 1, "only the long one is stored")

	const stored = db.getVideosInWindow("2026-08-22T12:00:00.000Z")
	assert.ok(stored.some((v) => v.post_id === "long1"))
	assert.ok(!stored.some((v) => v.post_id === "short1"))
})

test("videos outside the 7-day window are dropped before the details call", async () => {
	const client = fakeClient()
	const fetchFeeds = fakeFetchFeeds({
		UC1: [
			{ videoId: "fresh1", publishedAt: "2026-08-29T08:00:00Z" },
			{ videoId: "stale1", publishedAt: "2026-08-01T08:00:00Z" }
		]
	})

	const result = await collectYouTubeVideos({ client, fetchFeeds, now: new Date("2026-08-29T12:00:00Z") })
	assert.equal(result.collected, 1, "only the video inside the window is collected")

	const stored = db.getVideosInWindow("2026-08-22T12:00:00.000Z")
	assert.ok(stored.some((v) => v.post_id === "fresh1"))
	assert.ok(!stored.some((v) => v.post_id === "stale1"))
})

test("one failing channel does not abort the rest", async () => {
	const client = fakeClient({
		listSubscriptions: async () => [
			{ channelId: "UC1", title: "@chan1" },
			{ channelId: "UC2", title: "@chan2" }
		]
	})
	const fetchFeeds = fakeFetchFeeds(
		{ UC2: [{ videoId: "ok1", publishedAt: "2026-08-29T08:00:00Z" }] },
		{ UC1: "404 feed not found" }
	)

	const result = await collectYouTubeVideos({ client, fetchFeeds, now: new Date("2026-08-29T12:00:00Z") })
	assert.equal(result.errors.length, 1)
	assert.ok(result.collected >= 1, "the healthy channel still got collected")
})

test("a quota failure fetching video details keeps videos already paid for", async () => {
	const client = fakeClient({
		listSubscriptions: async () => [
			{ channelId: "UC1", title: "@chan1" },
			{ channelId: "UC2", title: "@chan2" }
		],
		listVideoDetails: async (ids) => {
			const err = new QuotaExceededError("YouTube daily quota exhausted")
			err.partial = [{
				videoId: "ok1",
				title: "t",
				description: "d",
				channelTitle: "@chan1",
				publishedAt: "2026-08-29T08:00:00Z",
				views: 10,
				durationSec: 600
			}]
			throw err
		}
	})
	const fetchFeeds = fakeFetchFeeds({
		UC1: [{ videoId: "ok1", publishedAt: "2026-08-29T08:00:00Z" }],
		UC2: [{ videoId: "ok2", publishedAt: "2026-08-29T08:00:00Z" }]
	})

	const result = await collectYouTubeVideos({ client, fetchFeeds, now: new Date("2026-08-29T12:00:00Z") })
	assert.equal(result.collected, 1, "the batch fetched before the quota error is still stored")
	assert.ok(result.errors.some((e) => /quota/i.test(e)), "the quota failure is reported")

	const stored = db.getVideosInWindow("2026-08-22T12:00:00.000Z")
	assert.ok(stored.some((v) => v.post_id === "ok1"))
})

test("colliding subscription titles are reported, not silently dropped", async () => {
	const client = fakeClient({
		listSubscriptions: async () => [
			{ channelId: "UC1", title: "@chan1" },
			{ channelId: "UC2", title: "@chan1" }
		]
	})

	const result = await collectYouTubeVideos({ client, fetchFeeds: fakeFetchFeeds(), now: new Date("2026-08-29T12:00:00Z") })
	assert.ok(
		result.errors.some((e) => e.includes("@chan1") && e.includes("UC1") && e.includes("UC2")),
		"the collision names both channel ids"
	)
})

test("an unconfigured client collects nothing and does not throw", async () => {
	const result = await collectYouTubeVideos({ client: fakeClient({ isReady: () => false }) })
	assert.equal(result.collected, 0)
	assert.deepEqual(result.perChannel, [])
})

test("a thrown YouTube collector still returns a result envelope", async () => {
	const client = fakeClient({
		listSubscriptions: async () => { throw new Error("network is down") }
	})

	const result = await collectYouTubeVideos({ client, fetchFeeds: fakeFetchFeeds(), now: new Date("2026-08-29T12:00:00Z") })
	assert.ok(result.errors.length > 0, "the failure is reported")
	assert.equal(typeof result.collected, "number", "the caller always gets a usable envelope")
})

test("a channel whose last video is 200 days old is not polled by the daily collect", async () => {
	const now = new Date()
	const oldVideoAt = new Date(Date.now() - 200 * 86400_000).toISOString()

	db.upsertYouTubeChannel("yt:@old1", "UCold1", 0)
	db.updateChannelActivity("yt:@old1", { lastVideoAt: oldVideoAt }) // also sets last_checked_at = now

	let called = false
	const client = fakeClient({
		listSubscriptions: async () => [{ channelId: "UCold1", title: "@old1" }]
	})
	const fetchFeeds = async (channelIds) => {
		if (channelIds.includes("UCold1")) called = true
		return { byChannel: new Map(channelIds.map((id) => [id, []])), errors: [] }
	}

	await collectYouTubeVideos({ client, fetchFeeds, now })
	assert.equal(called, false, "checked today with an old last video, so it's skipped")
})

test("a dormant channel is polled once its recheck window is stale, and skipped when checked yesterday", async () => {
	const now = new Date()
	const oldVideoAt = new Date(Date.now() - 200 * 86400_000).toISOString()
	const staleCheckedAt = new Date(Date.now() - 10 * 86400_000).toISOString()

	db.upsertYouTubeChannel("yt:@dormant1", "UCdormant1", 0)
	db.updateChannelActivity("yt:@dormant1", { lastVideoAt: oldVideoAt })
	db.default.prepare("UPDATE channels SET last_checked_at = ? WHERE username = ?").run(staleCheckedAt, "yt:@dormant1")

	let calls = 0
	const client = fakeClient({
		listSubscriptions: async () => [{ channelId: "UCdormant1", title: "@dormant1" }]
	})
	const fetchFeeds = async (channelIds) => {
		if (channelIds.includes("UCdormant1")) calls++
		return { byChannel: new Map(channelIds.map((id) => [id, []])), errors: [] }
	}

	await collectYouTubeVideos({ client, fetchFeeds, now })
	assert.equal(calls, 1, "stale recheck window triggers a poll")

	const yesterday = new Date(Date.now() - 1 * 86400_000).toISOString()
	db.default.prepare("UPDATE channels SET last_checked_at = ? WHERE username = ?").run(yesterday, "yt:@dormant1")

	calls = 0
	await collectYouTubeVideos({ client, fetchFeeds, now })
	assert.equal(calls, 0, "checked yesterday is still within the recheck window")
})

test("a channel with last_video_at IS NULL is polled (never-checked is not dormant)", async () => {
	const now = new Date()
	let called = false
	const client = fakeClient({
		listSubscriptions: async () => [{ channelId: "UCnew1", title: "@new1" }]
	})
	const fetchFeeds = async (channelIds) => {
		if (channelIds.includes("UCnew1")) called = true
		return { byChannel: new Map(channelIds.map((id) => [id, []])), errors: [] }
	}

	await collectYouTubeVideos({ client, fetchFeeds, now })
	assert.ok(called, "a brand-new subscription with no last_video_at is polled")
})

test("updateChannelActivity does not move last_video_at backwards", () => {
	const newer = new Date(Date.now() - 5 * 86400_000).toISOString()
	const older = new Date(Date.now() - 20 * 86400_000).toISOString()

	db.upsertYouTubeChannel("yt:@monotonic1", "UCmonotonic1", 0)
	db.updateChannelActivity("yt:@monotonic1", { lastVideoAt: newer })
	db.updateChannelActivity("yt:@monotonic1", { lastVideoAt: older })

	const row = db.default.prepare("SELECT last_video_at FROM channels WHERE username = ?").get("yt:@monotonic1")
	assert.equal(row.last_video_at, newer)
})

test("a dormant channel that publishes again is polled, updates last_video_at, and appears in the active set", async () => {
	const now = new Date()
	const oldVideoAt = new Date(Date.now() - 200 * 86400_000).toISOString()
	const staleCheckedAt = new Date(Date.now() - 10 * 86400_000).toISOString()
	const freshPublishedAt = new Date(Date.now() - 1 * 86400_000).toISOString()

	db.upsertYouTubeChannel("yt:@revived1", "UCrevived1", 0)
	db.updateChannelActivity("yt:@revived1", { lastVideoAt: oldVideoAt })
	db.default.prepare("UPDATE channels SET last_checked_at = ? WHERE username = ?").run(staleCheckedAt, "yt:@revived1")

	const client = fakeClient({
		listSubscriptions: async () => [{ channelId: "UCrevived1", title: "@revived1" }],
		listVideoDetails: async (ids) => ids.map((id) => ({
			videoId: id,
			title: "t",
			description: "d",
			channelTitle: "@revived1",
			publishedAt: freshPublishedAt,
			views: 10,
			durationSec: 600
		}))
	})
	const fetchFeeds = fakeFetchFeeds({ UCrevived1: [{ videoId: "revivedVid1", publishedAt: freshPublishedAt }] })

	const result = await collectYouTubeVideos({ client, fetchFeeds, now })
	assert.ok(result.collected >= 1, "the fresh video is collected")

	const active = db.getActiveYouTubeChannels(180)
	assert.ok(active.some((c) => c.username === "yt:@revived1"), "now appears in the active set")
})

test("a channel with both columns NULL is polled, and drops out of the active set once checked-and-empty", async () => {
	const now = new Date()
	let called = false
	const client = fakeClient({
		listSubscriptions: async () => [{ channelId: "UCblank1", title: "@blank1" }]
	})
	const fetchFeeds = async (channelIds) => {
		if (channelIds.includes("UCblank1")) called = true
		return { byChannel: new Map(channelIds.map((id) => [id, []])), errors: [] }
	}

	await collectYouTubeVideos({ client, fetchFeeds, now })
	assert.ok(called, "brand-new subscription (both columns NULL) is polled")

	const active = db.getActiveYouTubeChannels(180)
	assert.ok(!active.some((c) => c.username === "yt:@blank1"), "checked-and-empty is no longer 'new', so it's not active")
})

test("a checked-and-empty channel becomes dormant-due once its recheck window passes, and never lands in both sets", async () => {
	db.upsertYouTubeChannel("yt:@blank2", "UCblank2", 0)
	db.updateChannelActivity("yt:@blank2", {}) // stamps last_checked_at = now, last_video_at stays NULL
	const staleCheckedAt = new Date(Date.now() - 10 * 86400_000).toISOString()
	db.default.prepare("UPDATE channels SET last_checked_at = ? WHERE username = ?").run(staleCheckedAt, "yt:@blank2")

	const active = db.getActiveYouTubeChannels(180)
	const dormant = db.getDormantYouTubeChannelsDueForRecheck(180, 7)

	assert.ok(!active.some((c) => c.username === "yt:@blank2"), "not active — it's been checked before and found nothing")
	assert.ok(dormant.some((c) => c.username === "yt:@blank2"), "due for recheck once the window passes")
	assert.ok(
		!(active.some((c) => c.username === "yt:@blank2") && dormant.some((c) => c.username === "yt:@blank2")),
		"the two sets never overlap for the same channel"
	)
})

test("backfillChannelActivity: an empty feed yields null and leaves last_video_at NULL", async () => {
	db.upsertYouTubeChannel("yt:@backfillempty1", "UCbackfillempty1", 0)
	const client = fakeClient()
	const fetchFeeds = fakeFetchFeeds({ UCbackfillempty1: [] })

	const results = await backfillChannelActivity({ client, fetchFeeds })
	const entry = results.find((r) => r.channel === "yt:@backfillempty1")
	assert.ok(entry, "channel appears in the results")
	assert.equal(entry.lastVideoAt, null)

	const row = db.default.prepare("SELECT last_video_at, last_checked_at FROM channels WHERE username = ?").get("yt:@backfillempty1")
	assert.equal(row.last_video_at, null)
	assert.ok(row.last_checked_at, "last_checked_at is stamped even with no video found")
})

test("backfillChannelActivity: a failing channel is recorded and the loop continues to the next channel", async () => {
	db.upsertYouTubeChannel("yt:@backfillbad1", "UCbackfillbad1", 0)
	db.upsertYouTubeChannel("yt:@backfillgood1", "UCbackfillgood1", 0)

	const client = fakeClient()
	const fetchFeeds = fakeFetchFeeds(
		{ UCbackfillgood1: [{ videoId: "goodvid1", publishedAt: "2026-08-28T00:00:00Z" }] },
		{ UCbackfillbad1: "404 feed not found" }
	)

	const results = await backfillChannelActivity({ client, fetchFeeds })
	const bad = results.find((r) => r.channel === "yt:@backfillbad1")
	const good = results.find((r) => r.channel === "yt:@backfillgood1")

	assert.ok(bad.error, "the failure is recorded instead of aborting the run")
	assert.equal(good.lastVideoAt, "2026-08-28T00:00:00Z", "the next channel is still processed")

	const row = db.default.prepare("SELECT last_checked_at FROM channels WHERE username = ?").get("yt:@backfillbad1")
	assert.ok(row.last_checked_at, "a failed backfill still stamps last_checked_at so it doesn't poll daily forever")
})

test("backfillChannelActivity is idempotent on re-run", async () => {
	db.upsertYouTubeChannel("yt:@backfillidem1", "UCbackfillidem1", 0)
	const client = fakeClient()
	const fetchFeeds = fakeFetchFeeds({ UCbackfillidem1: [{ videoId: "idemvid1", publishedAt: "2026-08-27T00:00:00Z" }] })

	await backfillChannelActivity({ client, fetchFeeds })
	const firstRow = db.default.prepare("SELECT last_video_at FROM channels WHERE username = ?").get("yt:@backfillidem1")

	await backfillChannelActivity({ client, fetchFeeds })
	const secondRow = db.default.prepare("SELECT last_video_at FROM channels WHERE username = ?").get("yt:@backfillidem1")

	assert.equal(secondRow.last_video_at, firstRow.last_video_at, "re-running does not change the recorded value")
})
