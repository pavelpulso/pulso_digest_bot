import { test } from "node:test"
import assert from "node:assert/strict"

process.env.DB_PATH = ":memory:"
const db = await import("../src/db.js")
const {
	upsertVideo,
	upsertPostFeedback,
	recordYouTubeLikes,
	getYouTubeHitRate,
	markDigestShown,
	getOrCreateUser,
	getLikedUnwatchedVideos
} = db
const rawDb = db.default

test("a liked video id is matched to its post row and recorded as a youtube like", () => {
	const userId = 1
	getOrCreateUser(userId, "u1")
	upsertVideo("post-a", "yt:chan", "vid-a", "title a", "https://youtu.be/vid-a", 0, 600, new Date().toISOString())

	const inserted = recordYouTubeLikes(userId, ["vid-a"])
	assert.equal(inserted, 1)

	const row = rawDb.prepare("SELECT rating, source, watched_at FROM post_feedback WHERE user_id = ? AND post_id = ?").get(userId, "post-a")
	assert.equal(row.rating, 1)
	assert.equal(row.source, "youtube")
	assert.ok(row.watched_at, "a YouTube like is only possible after watching, so watched_at must be stamped")
})

test("a video liked on YouTube does not show up in /liked as still-to-watch", () => {
	const userId = 6
	getOrCreateUser(userId, "u6")
	upsertVideo("post-watched-on-yt", "yt:chan", "vid-watched", "title", "https://youtu.be/vid-watched", 0, 600, new Date().toISOString())

	recordYouTubeLikes(userId, ["vid-watched"])

	const queue = getLikedUnwatchedVideos(userId, 10)
	assert.equal(queue.length, 0, "a YouTube like is the reader's watch signal — it must not surface as unwatched")
})

test("a liked video id with no matching post is ignored, not inserted", () => {
	const userId = 2
	getOrCreateUser(userId, "u2")

	const inserted = recordYouTubeLikes(userId, ["unknown-vid"])
	assert.equal(inserted, 0)

	const row = rawDb.prepare("SELECT * FROM post_feedback WHERE user_id = ?").get(userId)
	assert.equal(row, undefined)
})

test("an existing bot dislike is not overwritten by a later youtube like", () => {
	const userId = 3
	getOrCreateUser(userId, "u3")
	upsertVideo("post-b", "yt:chan", "vid-b", "title b", "https://youtu.be/vid-b", 0, 600, new Date().toISOString())
	upsertPostFeedback(userId, "post-b", -1)

	const inserted = recordYouTubeLikes(userId, ["vid-b"])
	assert.equal(inserted, 0, "the deliberate bot verdict must win, so nothing new is inserted")

	const row = rawDb.prepare("SELECT rating, source FROM post_feedback WHERE user_id = ? AND post_id = ?").get(userId, "post-b")
	assert.deepEqual(row, { rating: -1, source: "bot" })
})

test("an existing bot like is left alone: no duplicate row, no source flip", () => {
	const userId = 4
	getOrCreateUser(userId, "u4")
	upsertVideo("post-c", "yt:chan", "vid-c", "title c", "https://youtu.be/vid-c", 0, 600, new Date().toISOString())
	upsertPostFeedback(userId, "post-c", 1)

	const inserted = recordYouTubeLikes(userId, ["vid-c"])
	assert.equal(inserted, 0)

	const rows = rawDb.prepare("SELECT rating, source FROM post_feedback WHERE user_id = ? AND post_id = ?").all(userId, "post-c")
	assert.equal(rows.length, 1)
	assert.deepEqual(rows[0], { rating: 1, source: "bot" })
})

test("hit rate counts only shown videos, and only likes that came after they were shown", () => {
	const userId = 5
	getOrCreateUser(userId, "u5")
	upsertVideo("post-shown", "yt:chan", "vid-shown", "t", "l", 0, 600, new Date().toISOString())
	upsertVideo("post-liked-early", "yt:chan", "vid-early", "t", "l", 0, 600, new Date().toISOString())
	upsertVideo("post-not-shown", "yt:chan", "vid-not-shown", "t", "l", 0, 600, new Date().toISOString())

	markDigestShown(userId, ["post-shown", "post-liked-early"])
	// Backdate this one's shown_at to well after its like, so the like predates the show.
	rawDb.prepare("UPDATE digest_shown SET shown_at = '2026-06-01T00:00:00.000Z' WHERE user_id = ? AND post_id = ?")
		.run(userId, "post-liked-early")
	rawDb.prepare(
		"INSERT INTO post_feedback (user_id, post_id, rating, source, created_at) VALUES (?, ?, 1, 'youtube', '2026-01-01T00:00:00.000Z')"
	).run(userId, "post-liked-early")

	recordYouTubeLikes(userId, ["vid-shown", "vid-not-shown"])

	const { shown, liked } = getYouTubeHitRate(userId, "2026-01-01T00:00:00.000Z")
	assert.equal(shown, 2, "only digest_shown rows count as shown")
	assert.equal(liked, 1, "the like that predates its own shown_at must not count")
})
