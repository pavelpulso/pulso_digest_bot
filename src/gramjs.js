import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions/index.js"
import { getSetting, getChannelUsernames, upsertPost } from "./db.js"
import { v4 as uuidv4 } from "uuid"
import { summarizeReactions, serializeReactions } from "./telegram/signals.js"

const apiId = parseInt(process.env.TG_API_ID, 10)
const apiHash = process.env.TG_API_HASH

function createClient() {
  const saved = getSetting("gramjs_session") || ""
  const session = new StringSession(saved)
  return new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
    timeout: 180,
    floodSleepThreshold: 180,
    maxAutoReconnect: 5
  })
}

/**
 * Collects posts from all channels within a specified time period.
 * @param {{ onProgress?: (opts: { channel: string, index: number, total: number, collected: number }) => void|Promise<void>, sinceTs?: number, untilTs?: number }} [options]
 * @returns {{ collected: number, errors: string[], perChannel: Array<{ channel: string, count: number, error?: string }> }}
 */
export async function collectChannelPosts(options = {}) {
  const { onProgress, sinceTs: customSinceTs, untilTs: customUntilTs } = options
  const channelUsernames = getChannelUsernames()
  if (channelUsernames.length === 0) {
    console.log("[collectChannelPosts] No channels to collect from. Add channels first.")
    return { collected: 0, errors: ["No channels configured. Add channels via /add or forward a post."], perChannel: [] }
  }

  // Validate API credentials
  if (!apiId || !apiHash) {
    console.error("[collectChannelPosts] Missing TG_API_ID or TG_API_HASH in .env")
    return { collected: 0, errors: ["Missing Telegram API credentials. Set TG_API_ID and TG_API_HASH in .env"], perChannel: [] }
  }

  const client = createClient()
  const errors = []
  const perChannel = []
  let collected = 0
  const total = channelUsernames.length

  console.log(`[collectChannelPosts] Starting collection from ${total} channels...`)

  try {
    await client.connect()
    console.log("[collectChannelPosts] Connected to Telegram.")
  } catch (e) {
    const errMsg = `GramJS connect: ${e.message}`
    console.error(`[collectChannelPosts] ${errMsg}`)
    errors.push(errMsg)
    return { collected: 0, errors, perChannel: [] }
  }

  const nowTs = Math.floor(Date.now() / 1000)
  const sinceTs = customSinceTs || (nowTs - 24 * 60 * 60)
  const untilTs = customUntilTs || nowTs
  
  console.log(`[collectChannelPosts] Time range: ${new Date(sinceTs * 1000).toISOString()} to ${new Date(untilTs * 1000).toISOString()}`)

  for (let i = 0; i < channelUsernames.length; i++) {
    const username = channelUsernames[i]
    const channelName = username.startsWith("@") ? username : `@${username}`
    const channelKey = channelName.replace(/^@/, "")
    if (onProgress) {
      await Promise.resolve(onProgress({ channel: channelKey, index: i + 1, total, collected }))
    }
    try {
      console.log(`[collectChannelPosts] Processing ${i + 1}/${total}: @${channelKey}`)
      const count = await collectFromChannel(client, channelName, sinceTs, untilTs)
      collected += count
      console.log(`[collectChannelPosts] @${channelKey}: ${count} posts`)
      perChannel.push({ channel: channelKey, count })
    } catch (e) {
      const errMsg = `${username}: ${e.message}`
      console.error(`[collectChannelPosts] Error for @${channelKey}: ${e.message}`)
      errors.push(errMsg)
      perChannel.push({ channel: channelKey, count: 0, error: e.message })
    }
  }

  try {
    await client.disconnect()
    console.log("[collectChannelPosts] Disconnected from Telegram.")
  } catch (e) {
    console.warn("[collectChannelPosts] Disconnect error:", e.message)
  }

  console.log(`[collectChannelPosts] Finished. Total: ${collected} posts, ${errors.length} errors.`)
  return { collected, errors, perChannel }
}

async function collectFromChannel(client, channelName, sinceTs, untilTs) {
  let count = 0

  for await (const message of client.iterMessages(channelName, {
    offsetDate: untilTs,
    limit: 500
  })) {
    if (message.date < sinceTs) break
    if (!message.id || (!message.text && !message.message)) continue

    const text = message.text || message.message || ""
    const views = message.views || 0
    const date = new Date(message.date * 1000).toISOString()
    const channel = channelName.replace(/^@/, "").toLowerCase()
    const link = `https://t.me/${channel}/${message.id}`
    const id = uuidv4()

    // forwards stays undefined when the channel forbids forwarding — passed through as
    // null so the ranking can tell "not allowed" from "nobody shared it".
    const forwards = typeof message.forwards === "number" ? message.forwards : null
    const reactions = serializeReactions(summarizeReactions(message.reactions))

    upsertPost(id, channel, message.id, text, link, views, date, forwards, reactions)
    count++
  }

  return count
}

/**
 * Fetches last N posts from a channel (regardless of time).
 * @param {string} channelName - @username or username
 * @param {number} limit - number of posts (default 20)
 * @returns {Promise<Array<{ id: string, channel: string, post_id: number, text: string, link: string, views: number, forwards: number|null, reactions: string|null, date: string }>>}
 */
export async function fetchRecentPostsFromChannel(channelName, limit = 20) {
  const client = createClient()
  const posts = []

  try {
    await client.connect()
  } catch (e) {
    throw new Error(`GramJS connect: ${e.message}`, { cause: e })
  }

  try {
    // Fetch more messages to account for media-only posts we'll skip
    // Some channels have many posts without text (photos, videos, polls)
    const fetchLimit = limit * 3
    let fetched = 0
    
    for await (const message of client.iterMessages(channelName, { limit: fetchLimit })) {
      if (!message.id) continue
      
      // Skip media-only posts (no text content)
      if (!message.text && !message.message) continue

      const text = message.text || message.message || ""
      const views = message.views || 0
      const date = new Date(message.date * 1000).toISOString()
      const channel = channelName.replace(/^@/, "").toLowerCase()
      const link = `https://t.me/${channel}/${message.id}`
      const id = uuidv4()
      const forwards = typeof message.forwards === "number" ? message.forwards : null
      const reactions = serializeReactions(summarizeReactions(message.reactions))

      // Save to DB
      upsertPost(id, channel, message.id, text, link, views, date, forwards, reactions)

      posts.push({ id, channel, post_id: message.id, text, link, views, forwards, reactions, date })
      fetched++
      
      // Stop when we have enough text posts
      if (fetched >= limit) break
    }
  } finally {
    try {
      await client.disconnect()
    } catch (e) {
      console.warn("GramJS disconnect error:", e.message)
    }
  }

  return posts
}

export default { collectChannelPosts, createClient, fetchRecentPostsFromChannel }
