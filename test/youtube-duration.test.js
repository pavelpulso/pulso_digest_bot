import { test } from "node:test"
import assert from "node:assert/strict"
import { parseISODuration, isShort } from "../src/youtube/duration.js"

test("YouTube durations parse into seconds", () => {
	assert.equal(parseISODuration("PT59S"), 59)
	assert.equal(parseISODuration("PT1M"), 60)
	assert.equal(parseISODuration("PT1M30S"), 90)
	assert.equal(parseISODuration("PT1H2M3S"), 3723)
	assert.equal(parseISODuration("P1DT2H"), 93600)
})

test("an unparseable duration is zero, not a crash", () => {
	assert.equal(parseISODuration(""), 0)
	assert.equal(parseISODuration(null), 0)
	assert.equal(parseISODuration("garbage"), 0)
})

test("a short is a minute or less, a minute and one second is not", () => {
	assert.equal(isShort(59), true)
	assert.equal(isShort(60), true)
	assert.equal(isShort(61), false)
})
