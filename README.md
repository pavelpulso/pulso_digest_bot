# Pulso Digest Bot

Telegram bot that aggregates posts from channels and delivers a personalized digest (Node.js, GramJS, Gemini API, SQLite).

## Stack

- Node.js 20+
- Telegraf, GramJS (telegram), better-sqlite3, node-cron
- Gemini API via an OpenAI-compatible proxy (xray)
- **SQLite** database (file `data/db.sqlite`)

## Setup and deploy

```bash
npm install
cp .env.example .env
# Fill in .env (BOT_TOKEN, TG_API_ID, TG_API_HASH, GEMINI_*, ADMIN_ID, etc.)

# First run — obtain GramJS session
node src/auth.js

# Run with PM2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Deploy to VPS

Repository: **https://github.com/pavelpulso/pulso_digest_bot**

### Simple way (no GitHub Actions)

1. **One-time on VPS**  
   Clone the project and configure the environment:

   ```bash
   cd /home/your_user   # or another directory
   git clone https://github.com/pavelpulso/pulso_digest_bot.git
   cd pulso_digest_bot
   cp .env.example .env
   # edit .env
   node src/auth.js     # obtain GramJS session
   npm ci
   chmod +x deploy.sh
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup
   ```

2. **To deploy updates**  
   Push from your machine: `git push origin main`.

   **Option A — from your machine (one command):**  
   Create `.deploy.env` (copy from `.deploy.env.example`) and set your SSH target and path:
   ```bash
   cp .deploy.env.example .deploy.env
   # Edit .deploy.env: DEPLOY_SSH=user@your-vps-ip, DEPLOY_PATH=/home/user/pulso_digest_bot
   npm run deploy
   ```
   This SSHs to the VPS and runs `./deploy.sh` there (pull + npm ci + pm2 restart). `.deploy.env` is gitignored.

   **Option B — on the VPS:**  
   SSH in and run:
   ```bash
   cd /path/to/pulso_digest_bot
   ./deploy.sh
   ```
   No GitHub secrets or Actions — just SSH.

---

### Optional: auto-deploy on every push (GitHub Actions)

If you want the VPS to update automatically when you push to `main`:

1. One-time VPS setup as above. Remember the project path.
2. In the repo: **Settings → Secrets and variables → Actions** → add secrets: `VPS_HOST`, `VPS_USER`, `SSH_PRIVATE_KEY`, `DEPLOY_PATH` (see workflow file).
3. Each `git push origin main` will trigger the deploy workflow.

## Environment variables (.env)

| Variable | Description |
|----------|-------------|
| BOT_TOKEN | Bot token from @BotFather |
| TG_API_ID, TG_API_HASH | From my.telegram.org |
| TG_SESSION | GramJS session string (set after `node src/auth.js`) |
| CHANNELS | Initial channels, comma-separated, without @ |
| GEMINI_API_KEY, GEMINI_PROXY_URL, GEMINI_MODEL | Gemini via proxy |
| ADMIN_ID | Telegram user_id of the admin |
| DB_PATH | SQLite file path (default: ./data/db.sqlite) |

## Bot commands

- `/start` — Welcome and short help
- `/digest` — Top 10 posts for today
- `/profile` — View or set your profile (interests)
- `/minus_words word1, word2` — Exclude posts containing these words from your digest (comma-separated)
- `/summary` — Pick a date or **Weekly (last 7 days)** for a summary digest
- `/channels` — List tracked channels; **Channel settings** — hide a channel from digest or mark as important
- `/add @channel`, `/remove @channel` — Add or remove a channel

**Morning digest:** every day at **07:00** (Europe/Moscow) the bot sends a **teaser** (main hook) with a button "Open digest", then the first page of the digest. Posts are collected at 06:00.

**Feedback:** under each post in the digest you can tap **👍 Релевантно** / **👎 Не релевантно**; the bot uses this to improve future ranking for you.

**Channel recommendations:** in **Profile** → **Рекомендация каналов** the bot suggests channels that match your interests (from the current channel list); you can mark them as **Important** in one tap.

Forwarding a post from a channel to the bot adds that channel to the list.

Admin (ADMIN_ID): `/ban`, `/unban`, `/close`, `/open`, `/stats`.

## Project structure

- `src/index.js` — Entry point, starts bot and cron
- `src/bot.js` — Telegraf commands and handlers
- `src/cron.js` — Daily post collection (06:00)
- `src/gramjs.js` — Reading channels via GramJS
- `src/gemini.js` — Ranking and summary via Gemini
- `src/db.js` — SQLite (settings, channels, posts, rankings, users)
- `src/utils.js` — Formatting, pagination
- `src/auth.js` — GramJS session setup (run manually)
