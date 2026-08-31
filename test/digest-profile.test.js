import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRankPrompt, buildSummaryPrompt } from "../src/ai/prompts.js"

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "pulso-test-")), "db.sqlite")

const dbModule = await import("../src/db.js")
const { getOrCreateUser, updateUserProfile, getReaderProfile } = dbModule
const rawDb = dbModule.default

const posts = [{ id: "p1", channel: "somechannel", text: "Пост про найм первого сотрудника" }]

test("getReaderProfile prefers digest_profile over profile when both are set", () => {
	const userId = 1001
	getOrCreateUser(userId)
	updateUserProfile(userId, "INFJ, любит структуру.\n\nФОРМАТ ОТВЕТОВ: всегда TL;DR, Quick Win, Deep Dive")
	rawDb.prepare("UPDATE users SET digest_profile = ? WHERE user_id = ?").run("Интересуюсь AI-агентами и стартапами", userId)

	const user = getOrCreateUser(userId)
	assert.equal(getReaderProfile(user), "Интересуюсь AI-агентами и стартапами")
})

test("getReaderProfile falls back to profile when digest_profile is empty or NULL", () => {
	const userIdNull = 1002
	getOrCreateUser(userIdNull)
	updateUserProfile(userIdNull, "Читаю про финтех")
	let user = getOrCreateUser(userIdNull)
	assert.equal(getReaderProfile(user), "Читаю про финтех")

	const userIdEmpty = 1003
	getOrCreateUser(userIdEmpty)
	updateUserProfile(userIdEmpty, "Читаю про геймдев")
	rawDb.prepare("UPDATE users SET digest_profile = ? WHERE user_id = ?").run("   ", userIdEmpty)
	user = getOrCreateUser(userIdEmpty)
	assert.equal(getReaderProfile(user), "Читаю про геймдев")
})

test("an existing user row with no digest_profile column value behaves identically to before", () => {
	const userId = 1004
	getOrCreateUser(userId)
	updateUserProfile(userId, "Старый профиль без digest_profile")
	const user = getOrCreateUser(userId)
	assert.equal(user.digest_profile, null)
	assert.equal(getReaderProfile(user), "Старый профиль без digest_profile")
})

test("with digest_profile set, the ranking prompt contains it and not the old profile text", () => {
	const oldProfile = "ФОРМАТ ОТВЕТОВ: TL;DR, Quick Win, Deep Dive, таблицы"
	const newProfile = "Интересуюсь Rust и распределёнными системами"

	const prompt = buildRankPrompt(posts, newProfile, "", {}, null)

	assert.match(prompt, /Rust и распределёнными системами/)
	assert.ok(!prompt.includes(oldProfile), "the old profile text must not leak into the ranking prompt")
})

test("with digest_profile empty, the ranking prompt falls back to profile exactly as today", () => {
	const oldProfile = "Читаю про менеджмент и продукты"
	const user = { profile: oldProfile, digest_profile: null }

	const prompt = buildRankPrompt(posts, getReaderProfile(user), "", {}, null)

	assert.match(prompt, /Читаю про менеджмент и продукты/)
})

test("the same fallback holds for the summary prompt", () => {
	const list = [{ id: "1", channel: "c", text: "текст", link: "l" }]

	const userWithDigestProfile = { profile: "ФОРМАТ ОТВЕТОВ: TL;DR", digest_profile: "Интересуюсь дизайном" }
	const withDigest = buildSummaryPrompt(list, "29 августа", getReaderProfile(userWithDigestProfile), 5)
	assert.match(withDigest, /Интересуюсь дизайном/)
	assert.ok(!withDigest.includes("ФОРМАТ ОТВЕТОВ: TL;DR"))

	const userWithoutDigestProfile = { profile: "Интересуюсь дизайном и версткой", digest_profile: "" }
	const withoutDigest = buildSummaryPrompt(list, "29 августа", getReaderProfile(userWithoutDigestProfile), 5)
	assert.match(withoutDigest, /Интересуюсь дизайном и версткой/)
})

test("the same fallback holds for language detection", () => {
	const englishContent = [{ id: "1", channel: "c", text: "A new gadget was announced today by the company" }]

	const userRuDigestProfile = { profile: "some english profile text here", digest_profile: "Читаю каждый день про технологии и стартапы" }
	const ruPrompt = buildRankPrompt(englishContent, getReaderProfile(userRuDigestProfile), "", {}, null)
	assert.match(ruPrompt, /Respond in RUSSIAN/i, "digest_profile's language must drive detection when set")

	const userFallbackToProfile = { profile: "Читаю каждый день про технологии и стартапы", digest_profile: "" }
	const fallbackPrompt = buildRankPrompt(englishContent, getReaderProfile(userFallbackToProfile), "", {}, null)
	assert.match(fallbackPrompt, /Respond in RUSSIAN/i, "with digest_profile empty, language detection must fall back to profile, same as ranking content")
})
