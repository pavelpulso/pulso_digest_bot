import { test } from "node:test"
import assert from "node:assert/strict"

process.env.DB_PATH = ":memory:"
const db = await import("../src/db.js")
const { collectYouTubeVideos } = await import("../src/youtube/collector.js")

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
