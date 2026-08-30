import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "pulso-test-")), "db.sqlite")

const dbModule = await import("../src/db.js")
const { upsertPost, upsertPostFeedback, getPostFeedbackForRanking, getOrCreateUser } = dbModule
const rawDb = dbModule.default

test("feedback reaches ranking as what the reader liked, not as opaque ids", () => {
	const userId = 42
	getOrCreateUser(userId, "reader")
	upsertPost("post-liked", "somechannel", 1, "Как я нанял первого сотрудника и что пошло не так", "https://t.me/c/1", 0, new Date().toISOString())
	upsertPost("post-disliked", "somechannel", 2, "Курс доллара на сегодня: краткая сводка", "https://t.me/c/2", 0, new Date().toISOString())

	upsertPostFeedback(userId, "post-liked", 1)
	upsertPostFeedback(userId, "post-disliked", -1)

	const { likedDigest, disliked } = getPostFeedbackForRanking(userId)

	assert.match(likedDigest.join(" "), /нанял первого сотрудника/)
	assert.match(disliked.join(" "), /Курс доллара/)
	assert.ok(!likedDigest.join(" ").includes("post-liked"), "an id carries no signal for the model")
})

test("a youtube-sourced like and a bot-sourced like land in separate groups, not pooled", () => {
	const userId = 43
	getOrCreateUser(userId, "reader2")
	upsertPost("post-watched", "somechannel", 3, "Разбор архитектуры распределённой очереди", "https://t.me/c/3", 0, new Date().toISOString())
	upsertPost("post-guessed", "somechannel", 4, "Заголовок про новый фреймворк", "https://t.me/c/4", 0, new Date().toISOString())

	upsertPostFeedback(userId, "post-guessed", 1)
	rawDb.prepare(
		"INSERT INTO post_feedback (user_id, post_id, rating, source, watched_at) VALUES (?, ?, 1, 'youtube', datetime('now'))"
	).run(userId, "post-watched")

	const { likedWatched, likedDigest } = getPostFeedbackForRanking(userId)

	assert.match(likedWatched.join(" "), /распределённой очереди/)
	assert.match(likedDigest.join(" "), /новый фреймворк/)
	assert.ok(!likedWatched.join(" ").includes("фреймворк"), "the bot-side guess must not leak into the watched group")
	assert.ok(!likedDigest.join(" ").includes("очереди"), "the youtube-side watched like must not leak into the digest group")
})
