import "dotenv/config"
import { createServer } from "http"

const clientId = process.env.YOUTUBE_CLIENT_ID
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET

if (!clientId || !clientSecret) {
  console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env")
  console.error("Google Cloud → APIs & Services → Credentials → OAuth client ID → Desktop app")
  process.exit(1)
}

const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl"

function waitForCode(server) {
  return new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url, "http://localhost")
      const error = url.searchParams.get("error")
      const code = url.searchParams.get("code")

      res.end("You can close this tab now.")

      if (error) {
        reject(new Error(error))
      } else if (code) {
        resolve(code)
      }
    })
  })
}

async function main() {
  // Loopback flow: Google redirects the browser back to a local server we control, on an ephemeral port.
  const server = createServer()
  await new Promise((resolve) => server.listen(0, resolve))
  const port = server.address().port
  const redirectUri = `http://localhost:${port}`

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  authUrl.searchParams.set("client_id", clientId)
  authUrl.searchParams.set("redirect_uri", redirectUri)
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("scope", SCOPE)
  authUrl.searchParams.set("access_type", "offline")
  authUrl.searchParams.set("prompt", "consent")

  console.log("\nOpen this URL and grant access:\n")
  console.log(authUrl.toString(), "\n")

  const codePromise = waitForCode(server)
  const code = await codePromise
  server.close()

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  })
  const json = await res.json()

  if (!res.ok || !json.refresh_token) {
    console.error("Failed:", JSON.stringify(json))
    process.exit(1)
  }

  console.log("\nAdd this line to .env:\n")
  console.log(`YOUTUBE_REFRESH_TOKEN=${json.refresh_token}\n`)
  console.log(
    "This token carries scope youtube.force-ssl. If you had an older token issued for\n" +
    "youtube.readonly, replace it with this one — an old token keeps its old (read-only)\n" +
    "permissions and playlist writes will fail with a 403, not because anything is broken.\n"
  )
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
