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
