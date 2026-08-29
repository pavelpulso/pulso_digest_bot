import { test } from "node:test"
import assert from "node:assert/strict"
import { median, computeBoost } from "../src/youtube/scoring.js"

test("median handles both odd and even counts", () => {
	assert.equal(median([1, 5, 3]), 3)
	assert.equal(median([1, 2, 3, 4]), 2.5)
	assert.equal(median([]), 0)
})

test("a cold channel gets no boost, so the LLM decides alone", () => {
	assert.equal(computeBoost(100000, 1000, 4), 0, "fewer than 5 matured videos means no metric yet")
	assert.ok(computeBoost(100000, 1000, 5) > 0, "the metric switches on at 5")
})

test("ten times the channel norm doubles the score, fifty times does not go further", () => {
	assert.equal(computeBoost(10000, 1000, 10), 1)
	assert.equal(computeBoost(50000, 1000, 10), 1, "the log caps the boost so a viral video cannot burn the section")
})

test("views below the norm never push a fresh video down", () => {
	assert.equal(computeBoost(10, 1000, 10), 0, "a video published yesterday has not had time to gather views")
	assert.equal(computeBoost(0, 1000, 10), 0)
})

test("a missing norm is treated as no signal", () => {
	assert.equal(computeBoost(5000, 0, 10), 0)
})

test("a count that is not a number is treated as no history, not as a passing gate", () => {
	assert.equal(computeBoost(100000, 1000, NaN), 0)
	assert.equal(computeBoost(100000, 1000, undefined), 0)
})
