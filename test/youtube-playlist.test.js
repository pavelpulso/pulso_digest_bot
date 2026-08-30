import { test } from "node:test"
import assert from "node:assert/strict"
import { withServer } from "./helpers.js"

process.env.DB_PATH = ":memory:"
const db = await import("../src/db.js")
const { YouTubeClient, QuotaExceededError } = await import("../src/youtube/client.js")
const { syncPlaylist } = await import("../src/youtube/playlist.js")
const { PLAYLIST_SIZE } = await import("../src/services/BotService.js")

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

function handlerFor(state, { quotaOnInsert = false, notFoundPlaylistId = null } = {}) {
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
				const playlistId = url.searchParams.get("playlistId")
				if (notFoundPlaylistId && playlistId === notFoundPlaylistId) {
					res.writeHead(404, { "Content-Type": "application/json" })
					return res.end(JSON.stringify({ error: { code: 404, errors: [{ reason: "playlistNotFound" }] } }))
				}
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
		await syncPlaylist({ client, ranked: [] })
		await syncPlaylist({ client, ranked: [] })
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
			ranked: ["vExisting", "vNew"]
		})
		assert.equal(result.added, 1)
		assert.equal(state.insertCalls, 1)
		assert.ok(state.items.some((it) => it.videoId === "vNew"))
	})
})

test("the playlist converges to exactly PLAYLIST_SIZE when more candidates exist", async () => {
	clearPlaylistSetting()
	const state = makeState()
	const ranked = Array.from({ length: 40 }, (_, i) => `v${i}`)

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		const result = await syncPlaylist({ client, ranked })
		assert.equal(result.added, PLAYLIST_SIZE)
		assert.equal(state.items.length, PLAYLIST_SIZE)
		assert.deepEqual(new Set(state.items.map((it) => it.videoId)), new Set(ranked.slice(0, PLAYLIST_SIZE)))
	})
})

test("a video that falls out of the top PLAYLIST_SIZE is removed on the next run", async () => {
	clearPlaylistSetting()
	const state = makeState([{ id: "PIkeep", videoId: "vKeep" }, { id: "PIgone", videoId: "vGone" }])
	// vKeep stays inside PLAYLIST_SIZE; vGone drops to rank PLAYLIST_SIZE (just one past
	// the cutoff) — no buffer, so it must be evicted immediately, not just eventually.
	const ranked = ["vKeep", ...Array.from({ length: PLAYLIST_SIZE - 1 }, (_, i) => `vFiller${i}`), "vGone"]

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		const result = await syncPlaylist({ client, ranked })
		assert.equal(result.removed, 1)
		assert.equal(state.deleteCalls, 1)
		assert.ok(!state.items.some((it) => it.videoId === "vGone"))
		assert.ok(state.items.some((it) => it.videoId === "vKeep"))
	})
})

test("a video that stays in the top PLAYLIST_SIZE is not touched", async () => {
	clearPlaylistSetting()
	const state = makeState([{ id: "PIkeep", videoId: "vKeep" }])
	const ranked = ["vKeep", ...Array.from({ length: PLAYLIST_SIZE - 1 }, (_, i) => `vFiller${i}`)]

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		const result = await syncPlaylist({ client, ranked })
		assert.equal(result.removed, 0)
		assert.equal(state.deleteCalls, 0, "an untouched survivor must not be deleted and re-inserted")
		assert.ok(!state.items.some((it) => it.id !== "PIkeep" && it.videoId === "vKeep"), "the surviving item keeps its original playlist item id")
	})
})

test("a better newcomer displaces a weaker incumbent immediately, with no buffer delay", async () => {
	clearPlaylistSetting()
	// Converge to a full 20-item playlist first.
	const initialRanked = Array.from({ length: PLAYLIST_SIZE }, (_, i) => `v${i}`)
	const state = makeState()

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		await syncPlaylist({ client, ranked: initialRanked })
		assert.equal(state.items.length, PLAYLIST_SIZE, "must start from a converged 20-item playlist")

		// vBetter scores above every incumbent; v0 (the weakest incumbent) drops to rank
		// PLAYLIST_SIZE, one past the cutoff. There is no buffer: the swap must happen
		// in this same run, not be deferred.
		const nextRanked = ["vBetter", ...Array.from({ length: PLAYLIST_SIZE - 1 }, (_, i) => `v${i + 1}`), "v0"]
		const result = await syncPlaylist({ client, ranked: nextRanked })
		assert.equal(result.added, 1, "the better newcomer is added in the same run it appears")
		assert.equal(result.removed, 1, "the displaced incumbent is removed in the same run")
		assert.equal(state.items.length, PLAYLIST_SIZE, "size stays at PLAYLIST_SIZE through the swap")
		assert.ok(state.items.some((it) => it.videoId === "vBetter"))
		assert.ok(!state.items.some((it) => it.videoId === "v0"))
	})
})

test("the size holds at exactly PLAYLIST_SIZE across several consecutive days of churn", async () => {
	clearPlaylistSetting()
	const state = makeState()

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		// Each day, the whole roster shifts by one: dayN's ranked list is v_N..v_(N+19).
		for (let day = 0; day < 10; day++) {
			const ranked = Array.from({ length: PLAYLIST_SIZE }, (_, i) => `v${day + i}`)
			await syncPlaylist({ client, ranked })
			assert.equal(state.items.length, PLAYLIST_SIZE, `size must stay at ${PLAYLIST_SIZE} on day ${day}`)
		}
	})
})

test("running the sync twice in a row issues no writes the second time", async () => {
	clearPlaylistSetting()
	const state = makeState()
	const ranked = ["v1", "v2"]

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		await syncPlaylist({ client, ranked })
		const insertsAfterFirst = state.insertCalls
		const deletesAfterFirst = state.deleteCalls

		const second = await syncPlaylist({ client, ranked })
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
			() => syncPlaylist({ client, ranked: ["v1"] }),
			QuotaExceededError
		)
		assert.equal(state.insertCalls, 1, "a daily quota does not come back from a retry")
	})
})

test("a ranked list longer than the write limit does not issue more writes than the limit allows", async () => {
	clearPlaylistSetting()
	const state = makeState()
	const ranked = Array.from({ length: 100 }, (_, i) => `v${i}`)

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		const result = await syncPlaylist({ client, ranked, maxWrites: 10 })
		assert.equal(result.added, 10)
		assert.equal(state.insertCalls, 10, "the write ceiling must stop issuing inserts, not just stop counting them")
		assert.equal(result.skippedAdds, PLAYLIST_SIZE - 10)
	})
})

test("a stored id that 404s (playlistNotFound) leads to a new playlist being created and stored", async () => {
	clearPlaylistSetting()
	db.setSetting("yt_playlist_id", "PL_DEAD")
	const state = makeState()

	await withServer(handlerFor(state, { notFoundPlaylistId: "PL_DEAD" }), async (url) => {
		const client = makeClient(url)
		const result = await syncPlaylist({ client, ranked: ["v1"] })
		assert.equal(state.createCalls, 1, "the dead id must trigger exactly one recreate, not a retry loop")
		assert.notEqual(result.playlistId, "PL_DEAD")
		assert.equal(db.getSetting("yt_playlist_id"), result.playlistId, "the new id must be persisted, not just returned")
		assert.equal(result.added, 1, "the new (empty) playlist still gets the day's picks in the same run")
	})
})

test("a complete turnover of the whole target stays within the write ceiling", async () => {
	clearPlaylistSetting()
	// Simulates the worst case: the previous accumulative playlist left far more items
	// behind than the new fixed-size target, and none of today's ranked ids match any of them.
	const staleItems = Array.from({ length: 100 }, (_, i) => ({ id: `PIstale${i}`, videoId: `vStale${i}` }))
	const state = makeState(staleItems)
	const ranked = Array.from({ length: 100 }, (_, i) => `vNew${i}`)

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		const result = await syncPlaylist({ client, ranked })
		const totalWrites = state.insertCalls + state.deleteCalls
		assert.ok(totalWrites <= 60, `expected writes <= MAX_WRITES_PER_RUN (60), got ${totalWrites}`)
		assert.equal(result.added, PLAYLIST_SIZE)
		assert.equal(result.added + result.removed, totalWrites)
	})
})

test("a full-size target turning over entirely fits in a single run's write ceiling", async () => {
	clearPlaylistSetting()
	const staleItems = Array.from({ length: PLAYLIST_SIZE }, (_, i) => ({ id: `PIstale${i}`, videoId: `vStale${i}` }))
	const state = makeState(staleItems)
	const ranked = Array.from({ length: PLAYLIST_SIZE }, (_, i) => `vNew${i}`)

	await withServer(handlerFor(state), async (url) => {
		const client = makeClient(url)
		const result = await syncPlaylist({ client, ranked })
		assert.equal(result.added, PLAYLIST_SIZE)
		assert.equal(result.removed, PLAYLIST_SIZE)
		assert.equal(result.skippedAdds, 0)
		assert.equal(result.skippedRemoves, 0)
		assert.equal(state.items.length, PLAYLIST_SIZE)
	})
})
