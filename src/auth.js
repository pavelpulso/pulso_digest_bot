import "dotenv/config"
import { createInterface } from "readline"
import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions/index.js"
import { getSetting, setSetting } from "./db.js"

const apiId = parseInt(process.env.TG_API_ID, 10)
const apiHash = process.env.TG_API_HASH

if (!apiId || !apiHash) {
  console.error("Set TG_API_ID and TG_API_HASH in .env")
  process.exit(1)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const question = (q) => new Promise((res) => rl.question(q, res))

const saved = getSetting("gramjs_session") || ""
const session = new StringSession(saved)

const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5
})

async function main() {
  await client.start({
    phoneNumber: async () => await question("Номер телефона (с кодом страны): "),
    password: async () => await question("Пароль 2FA (если есть, иначе Enter): "),
    phoneCode: async () => await question("Код из Telegram: "),
    onError: (err) => console.error(err)
  })

  const sessionString = client.session.save()
  setSetting("gramjs_session", sessionString)
  console.log("\nСессия сохранена в БД (settings.gramjs_session).")
  console.log("Можно запускать бота: npm start")
  rl.close()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
