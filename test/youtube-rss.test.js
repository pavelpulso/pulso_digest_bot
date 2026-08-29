import { test } from "node:test"
import assert from "node:assert/strict"
import { withServer } from "./helpers.js"
import { parseChannelFeed, fetchChannelFeed, fetchFeeds } from "../src/youtube/rss.js"

const REALISTIC_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
	<id>yt:channel:UC1</id>
	<yt:channelId>UC1</yt:channelId>
	<title>Test Channel</title>
	<entry>
		<id>yt:video:vid1</id>
		<yt:videoId>vid1</yt:videoId>
		<yt:channelId>UC1</yt:channelId>
		<title>First &amp; Best</title>
		<published>2026-08-29T10:00:00+00:00</published>
		<updated>2026-08-29T11:00:00+00:00</updated>
		<media:group>
			<media:title>First &amp; Best</media:title>
			<media:description>Some &lt;description&gt; with "quotes" &#39;here&#39;.</media:description>
			<media:community>
				<media:statistics views="12345"/>
			</media:community>
		</media:group>
	</entry>
	<entry>
		<id>yt:video:vid2</id>
		<yt:videoId>vid2</yt:videoId>
		<yt:channelId>UC1</yt:channelId>
		<title>Second video</title>
		<published>2026-08-27T10:00:00+00:00</published>
		<updated>2026-08-27T11:00:00+00:00</updated>
		<media:group>
			<media:title>Second video</media:title>
			<media:description>Plain description</media:description>
			<media:community>
				<media:statistics views="42"/>
			</media:community>
		</media:group>
	</entry>
</feed>`

test("parseChannelFeed extracts videos newest-first with the right fields", () => {
	const videos = parseChannelFeed(REALISTIC_FEED)
	assert.equal(videos.length, 2)
	assert.deepEqual(videos.map((v) => v.videoId), ["vid1", "vid2"])
	assert.equal(videos[0].publishedAt, "2026-08-29T10:00:00+00:00")
	assert.equal(videos[0].views, 12345)
	assert.equal(videos[1].views, 42)
})

test("parseChannelFeed decodes XML entities in title and description", () => {
	const videos = parseChannelFeed(REALISTIC_FEED)
	assert.equal(videos[0].title, "First & Best")
	assert.equal(videos[0].description, `Some <description> with "quotes" 'here'.`)
})

test("parseChannelFeed returns [] instead of throwing on garbage input", () => {
	assert.deepEqual(parseChannelFeed("<feed><entry><yt:videoId>onlyHalf"), [])
	assert.deepEqual(parseChannelFeed(""), [])
	assert.deepEqual(parseChannelFeed(null), [])
	assert.deepEqual(parseChannelFeed(undefined), [])
	assert.deepEqual(parseChannelFeed(12345), [])
})

test("fetchChannelFeed fetches and parses from an injectable baseUrl", async () => {
	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			assert.equal(url.pathname, "/feeds/videos.xml")
			assert.equal(url.searchParams.get("channel_id"), "UC1")
			res.writeHead(200, { "Content-Type": "application/xml" })
			res.end(REALISTIC_FEED)
		},
		async (url) => {
			const videos = await fetchChannelFeed("UC1", { baseUrl: url, timeoutMs: 2000 })
			assert.equal(videos.length, 2)
		}
	)
})

test("fetchFeeds fetches all channels with no more than `concurrency` requests in flight at once", async () => {
	let inFlight = 0
	let maxInFlight = 0

	await withServer(
		async (req, res) => {
			inFlight++
			maxInFlight = Math.max(maxInFlight, inFlight)
			await new Promise((resolve) => setTimeout(resolve, 20))
			inFlight--
			res.writeHead(200, { "Content-Type": "application/xml" })
			res.end(REALISTIC_FEED)
		},
		async (url) => {
			const channelIds = ["UC1", "UC2", "UC3", "UC4", "UC5"]
			const { byChannel, errors } = await fetchFeeds(channelIds, { concurrency: 2, baseUrl: url, timeoutMs: 2000 })
			assert.equal(byChannel.size, 5)
			assert.deepEqual(errors, [])
			assert.ok(maxInFlight <= 2, `observed ${maxInFlight} concurrent requests, expected at most 2`)
		}
	)
})

test("fetchFeeds isolates one channel's 404 without failing the batch", async () => {
	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			if (url.searchParams.get("channel_id") === "UC3") {
				res.writeHead(404, { "Content-Type": "text/plain" })
				return res.end("not found")
			}
			res.writeHead(200, { "Content-Type": "application/xml" })
			res.end(REALISTIC_FEED)
		},
		async (url) => {
			const channelIds = ["UC1", "UC2", "UC3", "UC4", "UC5"]
			const { byChannel, errors } = await fetchFeeds(channelIds, { concurrency: 3, baseUrl: url, timeoutMs: 2000 })
			assert.equal(byChannel.size, 4)
			assert.equal(errors.length, 1)
			assert.equal(errors[0].channelId, "UC3")
			assert.match(errors[0].message, /404/)
		}
	)
})
