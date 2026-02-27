import cron from "node-cron"
import { collectChannelPosts } from "./gramjs.js"
import { getChannelUsernames, addChannel } from "./db.js"
import { sendMorningDigests } from "./bot.js"

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
  console.log("[cron] Starting channel post collection...")
  seedChannelsFromEnv()
  const { collected, errors } = await collectChannelPosts()
  if (errors.length) console.error("[cron] Errors:", errors)
  console.log(`[cron] Collected ${collected} posts.`)
}

export function startCron(botInstance) {
  cron.schedule(CRON_SCHEDULE, runCollection, { timezone: "Europe/Moscow" })
  console.log("[cron] Scheduled daily collection at 06:00 (Europe/Moscow).")
  if (botInstance) {
    cron.schedule(MORNING_DIGEST_SCHEDULE, () => sendMorningDigests(botInstance), {
      timezone: "Europe/Moscow"
    })
    console.log("[cron] Scheduled morning digest at 07:00 (Europe/Moscow).")
  }
}

export async function runCollectionOnce() {
  await runCollection()
}
