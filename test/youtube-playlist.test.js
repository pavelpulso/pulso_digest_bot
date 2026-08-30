import { test } from "node:test"
import assert from "node:assert/strict"
import { withServer } from "./helpers.js"

process.env.DB_PATH = ":memory:"
const db = await import("../src/db.js")
const { YouTubeClient, QuotaExceededError } = await import("../src/youtube/client.js")
const { syncPlaylist } = await import("../src/youtube/playlist.js")

function clearPlaylistSetting() {
	db.default.prepare("DELETE FROM settings WHERE key = ?").run("yt_playlist_id")
}

function makeClient(url) {
	return new YouTubeClient({
		clientId: "cid",
		clientSecret: "secret",
		refreshToken: "refresh",
		baseUrl: url,
		oauthUrl: `${url}token`,
		timeoutMs: 2000
	})
}

/** In-memory fake YouTube API: tracks a single playlist's items and every write made to it. */
function makeState(initialItems = []) {
	return {
		nextPlaylistId: 1,
		playlistId: null,
		items: initialItems.slice(), // { id (playlistItemId), videoId }
		nextItemId: 1,
		createCalls: 0,
		insertCalls: 0,
		deleteCalls: 0
	}
}

function handlerFor(state, { quotaOnInsert = false } = {}) {
	return (req, res) => {
		const url = new URL(req.url, "http://x")
		if (url.pathname.endsWith("/token")) {
			res.writeHead(200, { "Content-Type": "application/json" })
			return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }))
		}

		let body = ""
		req.on("data", (c) => (body += c))
		req.on("end", () => {
			if (url.pathname.endsWith("/playlists") && req.method === "POST") {
				state.createCalls++
				state.playlistId = `PL${state.nextPlaylistId++}`
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ id: state.playlistId }))
			}
			if (url.pathname.endsWith("/playlistItems") && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({
					items: state.items.map((it) => ({
						id: it.id,
						snippet: { resourceId: { videoId: it.videoId } }
					}))
				}))
			}
			if (url.pathname.endsWith("/playlistItems") && req.method === "POST") {
				state.insertCalls++
				if (quotaOnInsert) {
					res.writeHead(403, { "Content-Type": "application/json" })
					return res.end(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }))
				}
				const { snippet } = JSON.parse(body)
				const item = { id: `PI${state.nextItemId++}`, videoId: snippet.resourceId.videoId }
				state.items.unshift(item)
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ id: item.id }))
			}
			if (url.pathname.endsWith("/playlistItems") && req.method === "DELETE") {
				state.deleteCalls++
				const id = url.searchParams.get("id")
				state.items = state.items.filter((it) => it.id !== id)
				res.writeHead(204)
				return res.end()
			}
			res.writeHead(404)
			res.end()
		})
	}
}

test("creating the playlist stores its id, and a second run reuses it", async () => {
	clearPlaylistSetting()
	const state = makeState()

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		await syncPlaylist({ client, picks: [], windowVideoIds: [] })
		await syncPlaylist({ client, picks: [], windowVideoIds: [] })
		assert.equal(state.createCalls, 1, "a second run must not create a second playlist")
		assert.equal(db.getSetting("yt_playlist_id"), state.playlistId)
	})
})

test("only missing videos are added — an already-present video costs no request", async () => {
	clearPlaylistSetting()
	const state = makeState([{ id: "PI1", videoId: "vExisting" }])

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		const result = await syncPlaylist({
			client,
			picks: ["vExisting", "vNew"],
			windowVideoIds: ["vExisting", "vNew"]
		})
		assert.equal(result.added, 1)
		assert.equal(state.insertCalls, 1)
		assert.ok(state.items.some((it) => it.videoId === "vNew"))
	})
})

test("an out-of-window entry is removed, an in-window one is not", async () => {
	clearPlaylistSetting()
	const state = makeState([
		{ id: "PIold", videoId: "vOld" },
		{ id: "PIkeep", videoId: "vKeep" }
	])

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		const result = await syncPlaylist({ client, picks: [], windowVideoIds: ["vKeep"] })
		assert.equal(result.removed, 1)
		assert.equal(state.deleteCalls, 1)
		assert.deepEqual(state.items.map((it) => it.videoId), ["vKeep"])
	})
})

test("running the sync twice in a row issues no writes the second time", async () => {
	clearPlaylistSetting()
	const state = makeState()

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		await syncPlaylist({ client, picks: ["v1", "v2"], windowVideoIds: ["v1", "v2"] })
		const insertsAfterFirst = state.insertCalls
		const deletesAfterFirst = state.deleteCalls

		const second = await syncPlaylist({ client, picks: ["v1", "v2"], windowVideoIds: ["v1", "v2"] })
		assert.equal(second.added, 0)
		assert.equal(second.removed, 0)
		assert.equal(state.insertCalls, insertsAfterFirst, "no new inserts on the second run")
		assert.equal(state.deleteCalls, deletesAfterFirst, "no new deletes on the second run")
	})
})

test("a 403 quota error surfaces as QuotaExceededError and does not retry", async () => {
	clearPlaylistSetting()
	const state = makeState()

	await withServer(handlerFor(state, { quotaOnInsert: true }), async (url) => {
		const client = makeClient(url)
		await assert.rejects(
			() => syncPlaylist({ client, picks: ["v1"], windowVideoIds: ["v1"] }),
			QuotaExceededError
		)
		assert.equal(state.insertCalls, 1, "a daily quota does not come back from a retry")
	})
})

test("a picks list longer than the write limit does not issue more writes than the limit allows", async () => {
	clearPlaylistSetting()
	const state = makeState()
	const picks = Array.from({ length: 100 }, (_, i) => `v${i}`)

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		const result = await syncPlaylist({ client, picks, windowVideoIds: picks, maxWrites: 10 })
		assert.equal(result.added, 10)
		assert.equal(state.insertCalls, 10, "the write ceiling must stop issuing inserts, not just stop counting them")
		assert.equal(result.skippedAdds, 90)
	})
})
