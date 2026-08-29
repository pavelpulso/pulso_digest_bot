# Pulso Digest Bot

Telegram bot that aggregates posts from tracked channels and YouTube subscriptions, delivering personalized digests using AI for ranking and summarization.

## Stack

- **Runtime:** Node.js 20+ (ES Modules)
- **Telegram Bot:** Telegraf
- **Telegram Client:** GramJS (`telegram` package) for MTProto channel reading
- **Database:** SQLite via `better-sqlite3` (file: `data/db.sqlite`)
- **AI:** Multi-provider (Gemini, Groq, OpenRouter) with auto-fallback
- **Scheduling:** System cron + `node-cron` (fallback)
- **Process Manager:** PM2

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your values (see Environment Variables below)

# First run — obtain GramJS session (one-time)
node src/auth.js

# Run with PM2 (production)
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Development

```bash
# Hot reload with nodemon
npm run dev

# Production mode
npm start

# Lint code
npm run lint
npm run lint:fix
```

## Deploy to VPS

Repository: **https://github.com/pavelpulso/pulso_digest_bot**

### One-time Setup

```bash
# Clone and setup
cd /home/your_user
git clone https://github.com/pavelpulso/pulso_digest_bot.git
cd pulso_digest_bot
cp .env.example .env
# Edit .env with your values
node src/auth.js     # Obtain GramJS session
npm ci
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

### Update Deployment

**Option A — From local machine (recommended):**
```bash
cp .deploy.env.example .deploy.env
# Edit .deploy.env: DEPLOY_SSH=user@your-vps-ip, DEPLOY_PATH=/path/to/pulso_digest_bot
npm run deploy
```

**Option B — On VPS:**
```bash
cd /path/to/pulso_digest_bot
./deploy.sh
```

### Cron Setup (Обязательно!)

Для надёжной работы ежедневного сбора постов и утреннего digest настройте системный cron:

```bash
# На VPS выполните:
crontab -e
```

Добавьте строки (замените путь на ваш):
```cron
# Сбор постов в 06:00 MSK
0 6 * * * cd /home/user/pulso_digest_bot && node src/cron-job.js --action=collect >> /var/log/pulso-cron.log 2>&1

# Утренний digest в 07:00 MSK
0 7 * * * cd /home/user/pulso_digest_bot && node src/cron-job.js --action=digest >> /var/log/pulso-cron.log 2>&1
```

**Важно:**
- Проверьте timezone сервера: `timedatectl` (должна быть Europe/Moscow)
- Путь к node: `which node` (может отличаться от `/usr/bin/node`)
- Логи: `tail -f /var/log/pulso-cron.log`

📖 Подробная инструкция: [docs/CRON_SETUP.md](docs/CRON_SETUP.md)

## Environment Variables (.env)

| Variable | Description | Required |
|----------|-------------|----------|
| `BOT_TOKEN` | Telegram bot token from @BotFather | Yes |
| `TG_API_ID` | API ID from my.telegram.org | Yes |
| `TG_API_HASH` | API Hash from my.telegram.org | Yes |
| `AI_PROVIDER` | AI provider: `auto`, `gemini`, `groq`, `openrouter` (default: `auto`) | No |
| `GEMINI_API_KEY` | Gemini API key (Google AI Studio) | Yes (if using Gemini) |
| `GEMINI_PROXY_URL` | Proxy URL for Gemini (e.g., `http://127.0.0.1:10808`) | Yes (if using Gemini) |
| `GEMINI_MODEL` | Gemini model (default: `gemini-3.6-flash`) | No |
| `GROQ_API_KEY` | Groq API key | Yes (if using Groq) |
| `GROQ_MODEL` | Groq model (default: `openai/gpt-oss-120b`) | No |
| `OPENROUTER_API_KEY` | OpenRouter API key | Yes (if using OpenRouter) |
| `OPENROUTER_MODEL` | OpenRouter model (default: `google/gemma-4-31b-it:free`) | No |
| `ADMIN_ID` | Telegram user_id of admin (for /ban, /close, etc.) | Yes |
| `CHANNELS` | Initial channels, comma-separated, without @ | No |
| `DB_PATH` | SQLite file path (default: `./data/db.sqlite`) | No |
| `DEBUG_AI` | Set to `1` or `true` to enable AI debug logging | No |
| `YOUTUBE_CLIENT_ID` | OAuth client ID (Desktop app) | Yes (if using YouTube) |
| `YOUTUBE_CLIENT_SECRET` | OAuth client secret | Yes (if using YouTube) |
| `YOUTUBE_REFRESH_TOKEN` | Refresh token from `npm run auth:youtube` | Yes (if using YouTube) |

**Note:** GramJS session is stored in the database (`settings.gramjs_session`), not in `.env`.

## Bot Commands

### User Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and help |
| `/digest` | Get top posts for today |
| `/profile` | View or set profile (interests) |
| `/minus_words` | Exclude posts containing specified words |
| `/summary` | Pick a date or get weekly summary (last 7 days) |
| `/channels` | List tracked channels and manage settings |
| `/add @channel` | Add a channel to tracking |
| `/remove @channel` | Remove a channel from tracking |
| `/menu` | Show main menu |
| `/digest_max` | Set max items per digest page (3-20) |
| `/digest_format` | Set digest format (full/compact) |

### Admin Commands (ADMIN_ID only)

| Command | Description |
|---------|-------------|
| `/ban` | Ban a user |
| `/unban` | Unban a user |
| `/close` | Close bot (stop accepting new users) |
| `/open` | Open bot |
| `/stats` | Show statistics |

## Product Features

### Morning Digest
- **06:00 MSK:** Posts collected from channels
- **07:00 MSK:** Teaser sent with "Open digest" button, followed by full digest
- Posts filtered by relevance score (≥ 0.5), limited by `digest_max_items`

### Personalization
- User profile (interests) influences AI ranking
- Channel priorities (normal/important)
- Hidden channels per user
- Minus-words filter
- Feedback (like/dislike) improves future rankings

### Digest Formats
- **Full:** Emoji + summary + action + potential + links
- **Compact:** Emoji + summary + links only
- "Why in digest" available via "📌 Подробнее" button

### Feedback
- 👍 Like / 👎 Dislike buttons under each post
- Feedback stored in `post_feedback` table and used for ranking

### Channel Recommendations
- AI recommends channels matching user interests
- One-tap "Important" marking for recommended channels

### Auto-Tracking
- Forwarding a post from a channel to the bot adds that channel to tracking

## Project Structure

```
src/
├── index.js        # Entry point: starts bot
├── bot.js          # Telegraf commands, handlers, inline keyboards
├── cron.js         # Cron functions (для node-cron fallback)
├── cron-job.js     # Standalone script для системного cron
├── gramjs.js       # Channel reading via MTProto (GramJS)
├── gemini.js       # Post ranking and digest generation via AI
├── db.js           # SQLite CRUD: users, channels, posts, rankings, feedback
├── utils.js        # Formatting, pagination, constants
└── auth.js         # GramJS session setup (run manually once)

data/
└── db.sqlite       # SQLite database file
```

## Database Schema

### Tables

- **`settings`** — Global settings (`gramjs_session`, `is_open`)
- **`channels`** — Tracked channels (username, added_by, added_at)
- **`posts`** — Collected posts (id, channel, post_id, text, link, views, date)
- **`rankings`** — Post rankings per user (user_id, post_id, score, reason, date)
- **`users`** — User profiles (user_id, username, profile, is_banned, digest_max_items, minus_keywords, digest_format)
- **`user_channel_settings`** — Per-user channel preferences (hidden, priority)
- **`post_feedback`** — User feedback on posts (user_id, post_id, rating: 1=like, -1=dislike)

### Key Constants (utils.js)

- `DIGEST_PAGE_SIZE = 10`
- `MIN_DIGEST_SCORE = 0.5` — Minimum score for digest inclusion

## Architecture Flow

1. **Collection (cron 06:00 MSK):** Системный cron → `cron-job.js` → `gramjs.js` fetches posts from last 24h → saves to `posts` table
2. **Ranking (on-demand):** `bot.js` → `gemini.js rankPosts()` → stores in `rankings` table
3. **Digest Generation:** `bot.js` → `gemini.js generateSummaryBlocks()` → sends to user
4. **Morning Delivery (cron 07:00 MSK):** Системный cron → `cron-job.js` → `sendMorningDigests()` → teaser with button → full digest

**Note:** System cron is preferred over `node-cron` for reliability. See [docs/CRON_SETUP.md](docs/CRON_SETUP.md)

## Development Conventions

- **Modules:** ES Modules (`import`/`export`), `"type": "module"` in package.json
- **Async:** `async`/`await` throughout
- **Naming:** camelCase for variables/functions, UPPER_CASE for constants
- **Database:** Synchronous `better-sqlite3` with WAL mode
- **Formatting:** HTML for Telegram messages (`parse_mode: "HTML"`)
- **Error Handling:** Console logging + user-friendly messages via `formatErrorForChat()`
- **Testing:** Manual testing via `npm run dev` (no automated tests)
- **Code Language:** All string literals and comments in English

## Related Files

| File | Purpose |
|------|---------|
| `ecosystem.config.cjs` | PM2 configuration |
| `deploy.sh` | VPS deployment script (pull + install + restart) |
| `deploy-remote.sh` | SSH wrapper for remote deployment |
| `.deploy.env.example` | Template for deployment config (SSH target, path) |
| `nodemon.json` | Nodemon configuration for development |

## Important Notes

- **GramJS session** is obtained once via `node src/auth.js` and stored in DB
- **Timezone:** All cron jobs use Europe/Moscow timezone
- **Post filtering:** Ads (ИНН, erid), hidden channels, minus-words are excluded
- **Ranking is personalized:** Based on profile, channel priorities, and feedback history
- **Forwarding:** Forwarding a post from a channel to the bot adds that channel to tracking
