import { test } from "node:test"
import assert from "node:assert/strict"
import {
	summarizeReactions,
	serializeReactions,
	parseReactions,
	computePolarity,
	computePolarityFactor,
	forwardRatio,
	computeForwardBoost,
	MAX_FORWARD_BOOST,
	MAX_POLARITY_LIFT,
	MAX_POLARITY_DROP
} from "../src/telegram/signals.js"

function emoji(emoticon, count) {
	return { reaction: { className: "ReactionEmoji", emoticon }, count }
}
function custom(count) {
	return { reaction: { className: "ReactionCustomEmoji", documentId: "123" }, count }
}

test("summarizeReactions splits named emoji from custom ones", () => {
	const s = summarizeReactions({ results: [emoji("🔥", 13), emoji("❤", 8), custom(2)] })
	assert.deepEqual(s, { e: { "🔥": 13, "❤": 8 }, c: 2 })
})

test("a channel whose reactions are all custom yields no polarity", () => {
	const s = summarizeReactions({ results: [custom(15)] })
	assert.deepEqual(s, { e: {}, c: 15 }, "the count is kept, it just cannot be classified")
	assert.equal(computePolarity(s), null)
})

test("summarizeReactions returns null when there are no reactions at all", () => {
	assert.equal(summarizeReactions(null), null)
	assert.equal(summarizeReactions({ results: [] }), null)
	assert.equal(summarizeReactions({ results: [emoji("🔥", 0)] }), null)
})

test("the variation selector does not split one emoji into two buckets", () => {
	const s = summarizeReactions({ results: [emoji("❤️", 5), emoji("❤", 3)] })
	assert.deepEqual(s, { e: { "❤": 8 }, c: 0 })
})

test("reactions survive a round trip through storage, and garbage does not throw", () => {
	const s = summarizeReactions({ results: [emoji("👍", 4)] })
	assert.deepEqual(parseReactions(serializeReactions(s)), { e: { "👍": 4 }, c: 0 })
	assert.equal(parseReactions(null), null)
	assert.equal(parseReactions("{not json"), null)
	assert.equal(parseReactions('{"nope":1}'), null)
})

test("polarity is the balance of positive against negative reactions", () => {
	const strong = summarizeReactions({ results: [emoji("🔥", 568), emoji("🤡", 133), emoji("👎", 4)] })
	assert.ok(computePolarity(strong) > 0.6, "fire outweighs the clowns")

	const sour = summarizeReactions({ results: [emoji("💩", 54), emoji("🤡", 22), emoji("👍", 9)] })
	assert.ok(computePolarity(sour) < -0.5, "a post that earned its reach through mockery")
})

test("neutral reactions are excluded from polarity, not counted as positive", () => {
	// 😁 dominates joke posts and means "funny", not "worth reading".
	const joke = summarizeReactions({ results: [emoji("😁", 978), emoji("👎", 30)] })
	assert.equal(computePolarity(joke), -1, "only the 30 downvotes are classified")
})

test("too few classified reactions is no signal", () => {
	const thin = summarizeReactions({ results: [emoji("🔥", 3), emoji("❤", 2)] })
	assert.equal(computePolarity(thin), null)
	assert.ok(computePolarity(summarizeReactions({ results: [emoji("🔥", 20)] })) !== null, "the metric switches on at 20")
})

test("the polarity factor lifts good posts and drops hostile ones harder", () => {
	assert.equal(computePolarityFactor(null), 1, "no data must not move the score either way")
	assert.equal(computePolarityFactor(0), 1)
	assert.equal(computePolarityFactor(1), 1 + MAX_POLARITY_LIFT)
	assert.equal(computePolarityFactor(-1), 1 - MAX_POLARITY_DROP)
	assert.ok(computePolarityFactor(-1) < 1, "unlike the view metric, polarity may push a post down")
})

test("forwardRatio separates a channel that forbids forwarding from one nobody shares", () => {
	assert.equal(forwardRatio(null, 10000), null)
	assert.equal(forwardRatio(0, 10000), 0)
	assert.equal(forwardRatio(120, 10000), 0.012)
	assert.equal(forwardRatio(10, 0), null)
})

test("the forward boost measures excess over the channel median and only lifts", () => {
	assert.equal(computeForwardBoost(100, 10000, 0.01, 4), 0, "fewer than 5 matured posts means no norm")
	assert.equal(computeForwardBoost(100, 10000, 0.01, 10), 0, "exactly at the norm is not a signal")
	assert.equal(computeForwardBoost(50, 10000, 0.01, 10), 0, "below the norm never pushes a post down")
	assert.ok(computeForwardBoost(200, 10000, 0.01, 10) > 0)
	assert.equal(computeForwardBoost(9000, 10000, 0.001, 10), MAX_FORWARD_BOOST, "the log caps a viral outlier")
})

test("a post whose channel forbids forwarding keeps its score untouched", () => {
	assert.equal(computeForwardBoost(null, 10000, 0.01, 10), 0)
})
