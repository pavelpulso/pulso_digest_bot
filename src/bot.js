import "dotenv/config"
import { BotManager } from "./core/BotManager.js"

const manager = new BotManager(process.env.BOT_TOKEN)
manager.init()

export const bot = manager.bot

/** For compatibility with cron.js and morning digest delivery */
export async function sendMorningDigests(botInstance) {
  // botInstance is passed for flexibility, but we use the manager service
  return manager.service.sendMorningDigests(botInstance || manager.bot)
}

export default bot
