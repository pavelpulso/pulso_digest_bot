import "dotenv/config"
import { BotManager } from "./core/BotManager.js"

const manager = new BotManager(process.env.BOT_TOKEN)
manager.init()

export const bot = manager.bot

/** Для совместимости с cron.js и утренней рассылкой */
export async function sendMorningDigests(botInstance) {
  // botInstance передается для гибкости, но мы используем сервис менеджера
  return manager.service.sendMorningDigests(botInstance || manager.bot)
}

export default bot
