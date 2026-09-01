import { test } from "node:test"
import assert from "node:assert/strict"
import { median, computeBoost, likeRatio, computeLikeBoost, MAX_LIKE_BOOST } from "../src/youtube/scoring.js"

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

test("likeRatio separates hidden likes from zero likes", () => {
	assert.equal(likeRatio(null, 10000), null, "the author hides likes: no data, not a bad video")
	assert.equal(likeRatio(undefined, 10000), null)
	assert.equal(likeRatio(0, 10000), 0, "zero likes on real views is data, and it is bad news")
	assert.equal(likeRatio(500, 10000), 0.05)
})

test("likeRatio ignores videos with too few views to trust the share", () => {
	assert.equal(likeRatio(30, 200), null, "200 views and 30 likes from the core is 15%, which never survives")
	assert.equal(likeRatio(30, 0), null)
})

test("a channel with too little like history gives no boost", () => {
	assert.equal(computeLikeBoost(1000, 10000, 0.03, 4), 0)
	assert.ok(computeLikeBoost(1000, 10000, 0.03, 5) > 0, "the metric switches on at 5")
})

test("the boost measures the excess over the channel median, not the absolute share", () => {
	assert.equal(computeLikeBoost(300, 10000, 0.03, 10), 0, "exactly at the channel norm is not a signal")
	assert.equal(computeLikeBoost(200, 10000, 0.03, 10), 0, "below the norm never pushes a video down")
	assert.ok(computeLikeBoost(600, 10000, 0.03, 10) > 0, "twice the channel norm is a signal")
})

test("the like boost is capped below the views boost", () => {
	assert.equal(computeLikeBoost(9000, 10000, 0.001, 10), MAX_LIKE_BOOST)
	assert.ok(MAX_LIKE_BOOST < 1, "likes must not outweigh views, they are easier to game")
})

test("hidden likes and missing norms are treated as no signal", () => {
	assert.equal(computeLikeBoost(null, 10000, 0.03, 10), 0, "hidden likes must not cost the video its score")
	assert.equal(computeLikeBoost(1000, 10000, 0, 10), 0)
	assert.equal(computeLikeBoost(1000, 10000, 0.03, NaN), 0)
	assert.equal(computeLikeBoost(1000, 10000, 0.03, undefined), 0)
})
