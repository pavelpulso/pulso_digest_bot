import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "pulso-test-")), "db.sqlite")

const { upsertPost, upsertPostFeedback, getPostFeedbackForRanking, getOrCreateUser } = await import("../src/db.js")

test("feedback reaches ranking as what the reader liked, not as opaque ids", () => {
	const userId = 42
	getOrCreateUser(userId, "reader")
	upsertPost("post-liked", "somechannel", 1, "Как я нанял первого сотрудника и что пошло не так", "https://t.me/c/1", 0, new Date().toISOString())
	upsertPost("post-disliked", "somechannel", 2, "Курс доллара на сегодня: краткая сводка", "https://t.me/c/2", 0, new Date().toISOString())

	upsertPostFeedback(userId, "post-liked", 1)
	upsertPostFeedback(userId, "post-disliked", -1)

	const { liked, disliked } = getPostFeedbackForRanking(userId)

	assert.match(liked.join(" "), /нанял первого сотрудника/)
	assert.match(disliked.join(" "), /Курс доллара/)
	assert.ok(!liked.join(" ").includes("post-liked"), "an id carries no signal for the model")
})
