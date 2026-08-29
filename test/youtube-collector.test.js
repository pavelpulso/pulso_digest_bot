import { test } from "node:test"
import assert from "node:assert/strict"

process.env.DB_PATH = ":memory:"
const db = await import("../src/db.js")
const { collectYouTubeVideos } = await import("../src/youtube/collector.js")
const { QuotaExceededError } = await import("../src/youtube/client.js")

function fakeClient(overrides = {}) {
	return {
		isReady: () => true,
		listSubscriptions: async () => [{ channelId: "UC1", title: "@chan1" }],
		listUploadPlaylists: async (ids) => new Map(ids.map((id) => [id, `UU${id.slice(2)}`])),
		listPlaylistVideos: async () => [{ videoId: "vid1", publishedAt: "2026-08-29T08:00:00Z" }],
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

test("a collected video lands in posts as a yt-source row", async () => {
	const result = await collectYouTubeVideos({ client: fakeClient(), now: new Date("2026-08-29T12:00:00Z") })

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
		listPlaylistVideos: async () => [
			{ videoId: "short1", publishedAt: "2026-08-29T08:00:00Z" },
			{ videoId: "long1", publishedAt: "2026-08-29T08:00:00Z" }
		],
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

	const result = await collectYouTubeVideos({ client, now: new Date("2026-08-29T12:00:00Z") })
	assert.equal(result.collected, 1, "only the long one is stored")

	const stored = db.getVideosInWindow("2026-08-22T12:00:00.000Z")
	assert.ok(stored.some((v) => v.post_id === "long1"))
	assert.ok(!stored.some((v) => v.post_id === "short1"))
})

test("one failing channel does not abort the rest", async () => {
	const client = fakeClient({
		listSubscriptions: async () => [
			{ channelId: "UC1", title: "@chan1" },
			{ channelId: "UC2", title: "@chan2" }
		],
		listPlaylistVideos: async (playlistId) => {
			if (playlistId === "UU1") throw new Error("404 playlist not found")
			return [{ videoId: "ok1", publishedAt: "2026-08-29T08:00:00Z" }]
		}
	})

	const result = await collectYouTubeVideos({ client, now: new Date("2026-08-29T12:00:00Z") })
	assert.equal(result.errors.length, 1)
	assert.ok(result.collected >= 1, "the healthy channel still got collected")
})

test("a quota failure mid-loop keeps videos already paid for", async () => {
	const client = fakeClient({
		listSubscriptions: async () => [
			{ channelId: "UC1", title: "@chan1" },
			{ channelId: "UC2", title: "@chan2" }
		],
		listPlaylistVideos: async (playlistId) => {
			if (playlistId === "UU2") throw new QuotaExceededError("YouTube daily quota exhausted")
			return [{ videoId: "ok1", publishedAt: "2026-08-29T08:00:00Z" }]
		}
	})

	const result = await collectYouTubeVideos({ client, now: new Date("2026-08-29T12:00:00Z") })
	assert.equal(result.collected, 1, "the channel fetched before the quota error is still stored")
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

	const result = await collectYouTubeVideos({ client, now: new Date("2026-08-29T12:00:00Z") })
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
		listSubscriptions: async () => { throw new Error("network is down") },
		listPlaylistVideos: async () => { throw new Error("network is down") }
	})

	const result = await collectYouTubeVideos({ client, now: new Date("2026-08-29T12:00:00Z") })
	assert.ok(result.errors.length > 0, "the failure is reported")
	assert.equal(typeof result.collected, "number", "the caller always gets a usable envelope")
})

test("a channel whose last video is 200 days old is not polled by the daily collect", async () => {
	const now = new Date("2026-08-29T12:00:00Z")
	const oldVideoAt = new Date(now.getTime() - 200 * 86400_000).toISOString()

	db.upsertYouTubeChannel("yt:@old1", "UUold1", 0)
	db.updateChannelActivity("yt:@old1", { lastVideoAt: oldVideoAt }) // also sets last_checked_at = now

	let called = false
	const client = fakeClient({
		listSubscriptions: async () => [{ channelId: "UCold1", title: "@old1" }],
		listPlaylistVideos: async (playlistId) => {
			if (playlistId === "UUold1") called = true
			return []
		}
	})

	await collectYouTubeVideos({ client, now })
	assert.equal(called, false, "checked today with an old last video, so it's skipped")
})

test("a dormant channel is polled once its recheck window is stale, and skipped when checked yesterday", async () => {
	const now = new Date("2026-08-29T12:00:00Z")
	const oldVideoAt = new Date(now.getTime() - 200 * 86400_000).toISOString()
	const staleCheckedAt = new Date(now.getTime() - 10 * 86400_000).toISOString()

	db.upsertYouTubeChannel("yt:@dormant1", "UUdormant1", 0)
	db.updateChannelActivity("yt:@dormant1", { lastVideoAt: oldVideoAt })
	db.default.prepare("UPDATE channels SET last_checked_at = ? WHERE username = ?").run(staleCheckedAt, "yt:@dormant1")

	let calls = 0
	const client = fakeClient({
		listSubscriptions: async () => [{ channelId: "UCdormant1", title: "@dormant1" }],
		listPlaylistVideos: async (playlistId) => {
			if (playlistId === "UUdormant1") calls++
			return []
		}
	})

	await collectYouTubeVideos({ client, now })
	assert.equal(calls, 1, "stale recheck window triggers a poll")

	const yesterday = new Date(now.getTime() - 1 * 86400_000).toISOString()
	db.default.prepare("UPDATE channels SET last_checked_at = ? WHERE username = ?").run(yesterday, "yt:@dormant1")

	calls = 0
	await collectYouTubeVideos({ client, now })
	assert.equal(calls, 0, "checked yesterday is still within the recheck window")
})

test("a channel with last_video_at IS NULL is polled (never-checked is not dormant)", async () => {
	const now = new Date("2026-08-29T12:00:00Z")
	let called = false
	const client = fakeClient({
		listSubscriptions: async () => [{ channelId: "UCnew1", title: "@new1" }],
		listUploadPlaylists: async (ids) => new Map(ids.map((id) => [id, "UUnew1"])),
		listPlaylistVideos: async (playlistId) => {
			if (playlistId === "UUnew1") called = true
			return []
		}
	})

	await collectYouTubeVideos({ client, now })
	assert.ok(called, "a brand-new subscription with no last_video_at is polled")
})

test("updateChannelActivity does not move last_video_at backwards", () => {
	db.upsertYouTubeChannel("yt:@monotonic1", "UUmonotonic1", 0)
	db.updateChannelActivity("yt:@monotonic1", { lastVideoAt: "2026-08-20T00:00:00Z" })
	db.updateChannelActivity("yt:@monotonic1", { lastVideoAt: "2026-08-01T00:00:00Z" })

	const row = db.default.prepare("SELECT last_video_at FROM channels WHERE username = ?").get("yt:@monotonic1")
	assert.equal(row.last_video_at, "2026-08-20T00:00:00Z")
})

test("a dormant channel that publishes again is polled, updates last_video_at, and appears in the active set", async () => {
	const now = new Date("2026-08-29T12:00:00Z")
	const oldVideoAt = new Date(now.getTime() - 200 * 86400_000).toISOString()
	const staleCheckedAt = new Date(now.getTime() - 10 * 86400_000).toISOString()
	const freshPublishedAt = "2026-08-28T00:00:00Z"

	db.upsertYouTubeChannel("yt:@revived1", "UUrevived1", 0)
	db.updateChannelActivity("yt:@revived1", { lastVideoAt: oldVideoAt })
	db.default.prepare("UPDATE channels SET last_checked_at = ? WHERE username = ?").run(staleCheckedAt, "yt:@revived1")

	const client = fakeClient({
		listSubscriptions: async () => [{ channelId: "UCrevived1", title: "@revived1" }],
		listPlaylistVideos: async (playlistId) => {
			if (playlistId === "UUrevived1") return [{ videoId: "revivedVid1", publishedAt: freshPublishedAt }]
			return []
		},
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

	const result = await collectYouTubeVideos({ client, now })
	assert.ok(result.collected >= 1, "the fresh video is collected")

	const active = db.getActiveYouTubeChannels(180)
	assert.ok(active.some((c) => c.username === "yt:@revived1"), "now appears in the active set")
})
