import cron from "node-cron"
import { collectChannelPosts } from "./gramjs.js"
import { getChannelUsernames, addChannel } from "./db.js"
import { BotManager } from "./core/BotManager.js"

const CRON_SCHEDULE = "0 6 * * *" // 06:00 daily
const MORNING_DIGEST_SCHEDULE = "0 7 * * *" // 07:00 — morning digest delivery

function seedChannelsFromEnv() {
  const list = (process.env.CHANNELS || "").split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean)
  const existing = new Set(getChannelUsernames())
  const adminId = parseInt(process.env.ADMIN_ID, 10) || 0
  for (const username of list) {
    if (!existing.has(username)) {
      addChannel(username, adminId)
      existing.add(username)
    }
  }
}

async function runCollection() {
  const startTime = Date.now()
  console.log("[cron] Starting channel post collection...")
  try {
    seedChannelsFromEnv()
    const { collected, errors, perChannel } = await collectChannelPosts()
    const elapsed = Math.round((Date.now() - startTime) / 1000)

    if (errors.length) {
      console.error("[cron] Errors:", errors)
    }
    console.log(`[cron] Collected ${collected} posts in ${elapsed}s.`)
    if (perChannel && perChannel.length > 0) {
      console.log("[cron] Per channel:", perChannel.map(c => `${c.channel}:${c.count}`).join(", "))
    }
  } catch (err) {
    console.error("[cron] Fatal error:", err.message, err.stack)
  }
}

async function runMorningDigest(botInstance) {
  console.log("[cron] Starting morning digest delivery...")
  try {
    // Use BotManager singleton to send morning digests
    const manager = new BotManager(process.env.BOT_TOKEN)
    await manager.service.sendMorningDigests(botInstance)
    console.log("[cron] Morning digest delivery completed.")
  } catch (err) {
    console.error("[cron] Morning digest error:", err.message, err.stack)
  }
}

export function startCron(botInstance) {
  cron.schedule(CRON_SCHEDULE, runCollection, { timezone: "Europe/Moscow" })
  console.log("[cron] Scheduled daily collection at 06:00 (Europe/Moscow).")
  if (botInstance) {
    cron.schedule(MORNING_DIGEST_SCHEDULE, () => runMorningDigest(botInstance), {
      timezone: "Europe/Moscow"
    })
    console.log("[cron] Scheduled morning digest at 07:00 (Europe/Moscow).")
  }
}

export async function runCollectionOnce() {
  await runCollection()
}
