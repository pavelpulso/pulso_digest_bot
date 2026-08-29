# YouTube Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в утренний дайджест секцию из трёх видео с подписок YouTube, отобранных по релевантности читателю и превышению просмотров над нормой канала, с хвостом до семи роликов под кнопкой.

**Architecture:** Видео сохраняется в существующую таблицу `posts` с `source='yt'` и проходит через готовый конвейер ранжирования, персонализации и скрытия каналов. Новый коллектор `src/youtube/` ходит в YouTube Data API v3 по OAuth. Показанное помечается в новой таблице `digest_shown`, которая заодно бесплатно даёт хвост под кнопкой «Ещё».

**Tech Stack:** Node.js 20 (ESM), better-sqlite3, telegraf, `node --test`, YouTube Data API v3 (OAuth 2.0, Desktop client).

**Spec:** `docs/superpowers/specs/2026-08-29-youtube-source-design.md`

## Global Constraints

- **Стиль отступов различается по директориям.** `src/ai/`, `src/db.js`, `src/youtube/` — 2 пробела. `src/ui/`, `src/services/`, `src/handlers/` — табы. Следовать файлу, который правишь.
- **Никаких новых npm-зависимостей.** Парсеры (ISO-8601, OAuth-обмен) пишутся руками поверх встроенного `fetch`.
- **Комментарии в коде — только там, где объясняют неочевидное «почему»,** не «что». Проект держит низкую плотность комментариев.
- **Все HTTP-клиенты принимают `baseUrl` в конструкторе** — тесты поднимают фейковый сервер через `withServer` из `test/helpers.js`, сеть в тестах не используется.
- **Тесты запускаются одной командой:** `npm test` (`node --test 'test/*.test.js'`). Файлы тестов лежат плоско в `test/`, не в поддиректориях.
- **Миграции схемы** — по существующему паттерну в `src/db.js`: `PRAGMA table_info(...)` + `ALTER TABLE ... ADD COLUMN` под `if (!cols.includes(...))`.
- **Дневной потолок видео:** 3 в ленте + 7 в хвосте = 10. Константы, не настройки.
- **Окно отбора:** 7 дней. **Окно медианы:** от 7 до 90 дней. **Порог шортса:** `duration_sec <= 60`.
- **Имена в БД:** источник `'tg'` / `'yt'`, канал видео — `yt:@handle`.

---

## File Structure

**Создаются:**

| Файл | Ответственность |
|---|---|
| `src/youtube/duration.js` | Парсер ISO-8601 длительности → секунды |
| `src/youtube/scoring.js` | Медиана канала и boost по просмотрам |
| `src/youtube/client.js` | HTTP к YouTube API: OAuth-токен, батчинг, обработка кодов |
| `src/youtube/collector.js` | `collectYouTubeVideos()` — синхронизация подписок и сбор видео |
| `src/auth-youtube.js` | Разовый OAuth consent, печатает refresh-токен |
| `test/youtube-duration.test.js` | Тесты парсера длительности |
| `test/youtube-scoring.test.js` | Тесты медианы и boost |
| `test/youtube-client.test.js` | Тесты клиента на фейковом сервере |
| `test/youtube-collector.test.js` | Тесты сбора и изоляции |
| `test/digest-video.test.js` | Тесты отбора, окна и кнопки «Ещё» |

**Модифицируются:**

| Файл | Что меняется |
|---|---|
| `src/db.js` | Миграции; фильтр `source='tg'` в существующих запросах; запросы видео и `digest_shown` |
| `src/cron-job.js` | Вызов YouTube-коллектора после телеграмного, в своём `try/catch` |
| `src/ui/UIFormatter.js` | Рендер видео-блока со второй строкой `▶ @channel · 22 мин · 47k` |
| `src/ui/KeyboardProvider.js` | Кнопка `📺 Ещё N видео` |
| `src/services/BotService.js` | Видео-секция в утренней рассылке, изолированная от текстовой |
| `src/handlers/ActionHandler.js` | Обработчик колбэка `video_more` |
| `src/core/BotManager.js:112` | Регистрация колбэка `video_more` |
| `.env.example`, `README.md` | Переменные OAuth и описание источника |

---

### Task 1: Схема — колонки, таблица, разделение источников

**Files:**
- Modify: `src/db.js` (блок миграций после строки ~90; запросы отбора на строках ~324-360)
- Test: `test/digest-video.test.js`

**Interfaces:**
- Consumes: ничего (первая задача)
- Produces:
  - `markDigestShown(userId, postIds: string[]): void`
  - `getShownPostIds(userId): Set<string>`
  - таблица `digest_shown(user_id, post_id, shown_at)`
  - колонки `posts.source`, `posts.duration_sec`, `channels.source`, `channels.external_id`, `channels.unsubscribed_at`

- [ ] **Step 1: Написать падающий тест**

Тест работает на отдельной БД в памяти — `DB_PATH` выставляется до импорта `db.js`, иначе модуль подхватит боевой путь.

```javascript
// test/digest-video.test.js
import { test } from "node:test"
import assert from "node:assert/strict"

process.env.DB_PATH = ":memory:"
const db = await import("../src/db.js")

test("a post defaults to the telegram source, so existing rows keep working", () => {
	db.upsertPost("p1", "somechannel", 100, "текст", "https://t.me/somechannel/100", 5, "2026-08-29T10:00:00.000Z")
	const post = db.getPostById("p1")
	assert.equal(post.source, "tg")
})

test("shown videos are remembered per user", () => {
	db.markDigestShown(42, ["v1", "v2"])
	const shown = db.getShownPostIds(42)
	assert.ok(shown.has("v1"))
	assert.ok(shown.has("v2"))
	assert.ok(!db.getShownPostIds(43).has("v1"), "another user has their own history")
})

test("marking the same video twice does not throw", () => {
	db.markDigestShown(42, ["v1"])
	db.markDigestShown(42, ["v1"])
	assert.ok(db.getShownPostIds(42).has("v1"))
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/digest-video.test.js`
Expected: FAIL — `db.markDigestShown is not a function`

- [ ] **Step 3: Добавить миграции**

В `src/db.js` после существующего блока миграций `users` (около строки 95):

```javascript
const postCols = db.prepare("PRAGMA table_info(posts)").all().map((c) => c.name)
if (!postCols.includes("source")) {
  db.prepare("ALTER TABLE posts ADD COLUMN source TEXT NOT NULL DEFAULT 'tg'").run()
}
if (!postCols.includes("duration_sec")) {
  db.prepare("ALTER TABLE posts ADD COLUMN duration_sec INTEGER").run()
}

const channelCols = db.prepare("PRAGMA table_info(channels)").all().map((c) => c.name)
if (!channelCols.includes("source")) {
  db.prepare("ALTER TABLE channels ADD COLUMN source TEXT NOT NULL DEFAULT 'tg'").run()
}
if (!channelCols.includes("external_id")) {
  db.prepare("ALTER TABLE channels ADD COLUMN external_id TEXT").run()
}
if (!channelCols.includes("unsubscribed_at")) {
  db.prepare("ALTER TABLE channels ADD COLUMN unsubscribed_at TEXT").run()
}

db.exec(`
  CREATE TABLE IF NOT EXISTS digest_shown (
    user_id INTEGER NOT NULL,
    post_id TEXT NOT NULL,
    shown_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, post_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_posts_source_date ON posts(source, date);
`)
```

- [ ] **Step 4: Добавить функции `digest_shown`**

В `src/db.js` рядом с другими экспортами:

```javascript
export function markDigestShown(userId, postIds) {
  if (!postIds || postIds.length === 0) return
  const stmt = db.prepare(
    "INSERT INTO digest_shown (user_id, post_id) VALUES (?, ?) ON CONFLICT(user_id, post_id) DO NOTHING"
  )
  const many = db.transaction((ids) => {
    for (const id of ids) stmt.run(userId, id)
  })
  many(postIds)
}

export function getShownPostIds(userId) {
  const rows = db.prepare("SELECT post_id FROM digest_shown WHERE user_id = ?").all(userId)
  return new Set(rows.map((r) => r.post_id))
}
```

- [ ] **Step 5: Запустить тест — должен пройти**

Run: `node --test test/digest-video.test.js`
Expected: PASS (3 теста)

- [ ] **Step 6: Отделить телеграмные посты от видео в существующих запросах**

Добавить `AND p.source = 'tg'` в `getRankedPostIdsAboveScore` и `getRankedPostIdsWithTotal` (обе — внутри `WHERE`, после условия по `r.date`), и `AND source = 'tg'` в `getPostsForCalendarDay` и `getPostsLast24h`.

В `getChannelUsernames` добавить фильтр, чтобы телеграмный коллектор не читал YouTube-каналы:

```javascript
export function getChannelUsernames() {
  return db.prepare("SELECT username FROM channels WHERE source = 'tg'").all().map((r) => r.username)
}
```

Также добавить `source` и `duration_sec` в списки колонок всех `SELECT ... FROM posts` (`getPostsLast24h`, `getPostsForCalendarDay`, `getPostById`, `getPostsByIds`) — иначе `post.source` вернётся `undefined` и тест из шага 1 упадёт.

- [ ] **Step 7: Дописать тест на разделение источников**

```javascript
test("videos do not leak into the telegram post selection", () => {
	db.upsertVideo("v9", "yt:@chan", "abc123", "заголовок", "https://youtube.com/watch?v=abc123", 1000, 600, "2026-08-29T10:00:00.000Z")
	const dayPosts = db.getPostsForCalendarDay("2026-08-29")
	assert.ok(!dayPosts.some((p) => p.id === "v9"), "a video must not appear among text posts")
})
```

- [ ] **Step 8: Добавить `upsertVideo`**

```javascript
export function upsertVideo(id, channel, videoId, text, link, views, durationSec, date) {
  db.prepare(
    `INSERT INTO posts (id, channel, post_id, text, link, views, date, source, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'yt', ?)
     ON CONFLICT(channel, post_id) DO UPDATE SET
       text = excluded.text,
       link = excluded.link,
       views = excluded.views,
       duration_sec = excluded.duration_sec`
  ).run(id, channel, videoId, text || "", link || "", views || 0, date, durationSec || null)
}
```

Обрати внимание: `date` при конфликте НЕ обновляется. Дата публикации видео неизменна, а перезапись сдвинула бы его в окне отбора при каждом сборе.

- [ ] **Step 9: Прогнать весь набор тестов**

Run: `npm test`
Expected: PASS — 23 существующих теста плюс 4 новых. Существующие не должны сломаться от фильтра `source='tg'`.

- [ ] **Step 10: Коммит**

```bash
git add src/db.js test/digest-video.test.js
git commit -m "Separate post sources in the schema"
```

---

### Task 2: Парсер длительности

**Files:**
- Create: `src/youtube/duration.js`
- Test: `test/youtube-duration.test.js`

**Interfaces:**
- Consumes: ничего
- Produces: `parseISODuration(value: string): number` — секунды, `0` для нераспознанного

- [ ] **Step 1: Написать падающий тест**

```javascript
// test/youtube-duration.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseISODuration, isShort } from "../src/youtube/duration.js"

test("YouTube durations parse into seconds", () => {
	assert.equal(parseISODuration("PT59S"), 59)
	assert.equal(parseISODuration("PT1M"), 60)
	assert.equal(parseISODuration("PT1M30S"), 90)
	assert.equal(parseISODuration("PT1H2M3S"), 3723)
	assert.equal(parseISODuration("P1DT2H"), 93600)
})

test("an unparseable duration is zero, not a crash", () => {
	assert.equal(parseISODuration(""), 0)
	assert.equal(parseISODuration(null), 0)
	assert.equal(parseISODuration("garbage"), 0)
})

test("a short is a minute or less, a minute and one second is not", () => {
	assert.equal(isShort(59), true)
	assert.equal(isShort(60), true)
	assert.equal(isShort(61), false)
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/youtube-duration.test.js`
Expected: FAIL — `Cannot find module '../src/youtube/duration.js'`

- [ ] **Step 3: Реализовать**

```javascript
// src/youtube/duration.js

/** Шортсом считается ролик не длиннее минуты — по нему же YouTube разделяет форматы. */
export const SHORT_MAX_SEC = 60

const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

export function parseISODuration(value) {
  if (!value || typeof value !== "string") return 0
  const m = ISO_DURATION.exec(value)
  if (!m) return 0
  const [, d, h, min, s] = m
  return (
    (parseInt(d, 10) || 0) * 86400 +
    (parseInt(h, 10) || 0) * 3600 +
    (parseInt(min, 10) || 0) * 60 +
    (parseInt(s, 10) || 0)
  )
}

export function isShort(durationSec) {
  return durationSec > 0 && durationSec <= SHORT_MAX_SEC
}
```

- [ ] **Step 4: Запустить тест**

Run: `node --test test/youtube-duration.test.js`
Expected: PASS (3 теста)

- [ ] **Step 5: Коммит**

```bash
git add src/youtube/duration.js test/youtube-duration.test.js
git commit -m "Parse YouTube durations without a dependency"
```

---

### Task 3: Скоринг — медиана канала и boost

**Files:**
- Create: `src/youtube/scoring.js`
- Test: `test/youtube-scoring.test.js`

**Interfaces:**
- Consumes: ничего
- Produces:
  - `median(values: number[]): number`
  - `computeBoost(views: number, medianViews: number, maturedCount: number): number` — от 0 до 1
  - `MIN_MATURED_VIDEOS = 5`

- [ ] **Step 1: Написать падающий тест**

Тесты закрепляют ровно те решения из спеки, которые иначе тихо развалятся при рефакторинге.

```javascript
// test/youtube-scoring.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { median, computeBoost } from "../src/youtube/scoring.js"

test("median handles both odd and even counts", () => {
	assert.equal(median([1, 5, 3]), 3)
	assert.equal(median([1, 2, 3, 4]), 2.5)
	assert.equal(median([]), 0)
})

test("a cold channel gets no boost, so the LLM decides alone", () => {
	assert.equal(computeBoost(100000, 1000, 4), 0, "fewer than 5 matured videos means no metric yet")
	assert.ok(computeBoost(100000, 1000, 5) > 0, "the metric switches on at 5")
})

test("ten times the channel norm doubles the score, fifty times does not go further", () => {
	assert.equal(computeBoost(10000, 1000, 10), 1)
	assert.equal(computeBoost(50000, 1000, 10), 1, "the log caps the boost so a viral video cannot burn the section")
})

test("views below the norm never push a fresh video down", () => {
	assert.equal(computeBoost(10, 1000, 10), 0, "a video published yesterday has not had time to gather views")
	assert.equal(computeBoost(0, 1000, 10), 0)
})

test("a missing norm is treated as no signal", () => {
	assert.equal(computeBoost(5000, 0, 10), 0)
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/youtube-scoring.test.js`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

```javascript
// src/youtube/scoring.js

/** Пока у канала меньше стольких созревших видео, медиана недостоверна. */
export const MIN_MATURED_VIDEOS = 5

export function median(values) {
  if (!values || values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Метрика умеет только поднимать скор. Видео, вышедшее вчера, физически не успело
 * набрать просмотры — если позволить метрике опускать, свежее всегда проиграет
 * недельному и «топ за 7 дней» станет «топом прошлой недели».
 */
export function computeBoost(views, medianViews, maturedCount) {
  if (maturedCount < MIN_MATURED_VIDEOS) return 0
  if (!medianViews || medianViews <= 0) return 0
  if (!views || views <= 0) return 0
  const ratio = views / medianViews
  if (ratio <= 1) return 0
  return Math.min(Math.log10(ratio), 1)
}
```

- [ ] **Step 4: Запустить тест**

Run: `node --test test/youtube-scoring.test.js`
Expected: PASS (5 тестов)

- [ ] **Step 5: Коммит**

```bash
git add src/youtube/scoring.js test/youtube-scoring.test.js
git commit -m "Score videos against their channel's own norm"
```

---

### Task 4: HTTP-клиент YouTube API

**Files:**
- Create: `src/youtube/client.js`
- Test: `test/youtube-client.test.js`

**Interfaces:**
- Consumes: ничего
- Produces: класс `YouTubeClient` с конструктором `({ clientId, clientSecret, refreshToken, baseUrl, oauthUrl, timeoutMs })` и методами:
  - `getAccessToken(): Promise<string>`
  - `listSubscriptions(): Promise<Array<{ channelId, title }>>`
  - `listUploadPlaylists(channelIds: string[]): Promise<Map<string, string>>`
  - `listPlaylistVideos(playlistId, sinceIso): Promise<Array<{ videoId, publishedAt }>>`
  - `listVideoDetails(videoIds: string[]): Promise<Array<{ videoId, title, description, views, durationSec, publishedAt, channelTitle }>>`

- [ ] **Step 1: Написать падающий тест — батчинг**

```javascript
// test/youtube-client.test.js
import { test } from "node:test"
import assert from "node:assert/strict"
import { withServer } from "./helpers.js"
import { YouTubeClient } from "../src/youtube/client.js"

function makeClient(url, overrides = {}) {
	return new YouTubeClient({
		clientId: "cid",
		clientSecret: "secret",
		refreshToken: "refresh",
		baseUrl: url,
		oauthUrl: `${url}token`,
		timeoutMs: 2000,
		...overrides
	})
}

test("120 video ids go out as three requests, not 120", async () => {
	const seenBatches = []

	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			if (url.pathname.endsWith("/token")) {
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }))
			}
			const ids = (url.searchParams.get("id") || "").split(",").filter(Boolean)
			seenBatches.push(ids.length)
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({
				items: ids.map((id) => ({
					id,
					snippet: { title: "t", description: "d", publishedAt: "2026-08-29T10:00:00Z", channelTitle: "c" },
					statistics: { viewCount: "100" },
					contentDetails: { duration: "PT10M" }
				}))
			}))
		},
		async (url) => {
			const client = makeClient(url)
			const ids = Array.from({ length: 120 }, (_, i) => `video${i}`)
			const details = await client.listVideoDetails(ids)
			assert.deepEqual(seenBatches, [50, 50, 20])
			assert.equal(details.length, 120)
			assert.equal(details[0].durationSec, 600)
			assert.equal(details[0].views, 100)
		}
	)
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/youtube-client.test.js`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать клиент**

```javascript
// src/youtube/client.js
import { parseISODuration } from "./duration.js"

const DEFAULT_BASE_URL = "https://www.googleapis.com/youtube/v3/"
const DEFAULT_OAUTH_URL = "https://oauth2.googleapis.com/token"
const BATCH_SIZE = 50
const DEFAULT_TIMEOUT_MS = 30_000

export class QuotaExceededError extends Error {}

export class YouTubeClient {
  constructor({ clientId, clientSecret, refreshToken, baseUrl, oauthUrl, timeoutMs } = {}) {
    this.clientId = clientId ?? process.env.YOUTUBE_CLIENT_ID ?? ""
    this.clientSecret = clientSecret ?? process.env.YOUTUBE_CLIENT_SECRET ?? ""
    this.refreshToken = refreshToken ?? process.env.YOUTUBE_REFRESH_TOKEN ?? ""
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/?$/, "/")
    this.oauthUrl = oauthUrl ?? DEFAULT_OAUTH_URL
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.accessToken = null
    this.accessTokenExpiresAt = 0
  }

  isReady() {
    return !!(this.clientId && this.clientSecret && this.refreshToken)
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token"
    })
    const res = await this.#fetch(this.oauthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(`YouTube OAuth ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
    }
    this.accessToken = json.access_token
    // Минута форы, чтобы токен не истёк посреди серии запросов.
    this.accessTokenExpiresAt = Date.now() + ((json.expires_in || 3600) - 60) * 1000
    return this.accessToken
  }

  async #fetch(url, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async #get(path, params) {
    const token = await this.getAccessToken()
    const url = new URL(path, this.baseUrl)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const res = await this.#fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    })
    const json = await res.json().catch(() => null)

    if (res.status === 403 && JSON.stringify(json).includes("quotaExceeded")) {
      // Квота суточная — ретрай её не вернёт, только сожжёт остаток.
      throw new QuotaExceededError("YouTube daily quota exhausted")
    }
    if (!res.ok) {
      throw new Error(`YouTube ${path} ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
    }
    return json
  }

  async #paged(path, params, onPage) {
    let pageToken = ""
    do {
      const json = await this.#get(path, pageToken ? { ...params, pageToken } : params)
      onPage(json.items || [])
      pageToken = json.nextPageToken || ""
    } while (pageToken)
  }

  async listSubscriptions() {
    const out = []
    await this.#paged("subscriptions", { part: "snippet", mine: "true", maxResults: String(BATCH_SIZE) }, (items) => {
      for (const it of items) {
        const channelId = it.snippet?.resourceId?.channelId
        if (channelId) out.push({ channelId, title: it.snippet?.title || channelId })
      }
    })
    return out
  }

  async listUploadPlaylists(channelIds) {
    const map = new Map()
    for (let i = 0; i < channelIds.length; i += BATCH_SIZE) {
      const batch = channelIds.slice(i, i + BATCH_SIZE)
      const json = await this.#get("channels", { part: "contentDetails", id: batch.join(","), maxResults: String(BATCH_SIZE) })
      for (const it of json.items || []) {
        const uploads = it.contentDetails?.relatedPlaylists?.uploads
        if (uploads) map.set(it.id, uploads)
      }
    }
    return map
  }

  async listPlaylistVideos(playlistId, sinceIso) {
    const out = []
    await this.#paged("playlistItems", { part: "contentDetails", playlistId, maxResults: String(BATCH_SIZE) }, (items) => {
      for (const it of items) {
        const videoId = it.contentDetails?.videoId
        const publishedAt = it.contentDetails?.videoPublishedAt
        if (videoId && publishedAt && publishedAt >= sinceIso) out.push({ videoId, publishedAt })
      }
    })
    return out
  }

  async listVideoDetails(videoIds) {
    const out = []
    for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
      const batch = videoIds.slice(i, i + BATCH_SIZE)
      const json = await this.#get("videos", {
        part: "snippet,statistics,contentDetails",
        id: batch.join(","),
        maxResults: String(BATCH_SIZE)
      })
      for (const it of json.items || []) {
        out.push({
          videoId: it.id,
          title: it.snippet?.title || "",
          description: it.snippet?.description || "",
          channelTitle: it.snippet?.channelTitle || "",
          publishedAt: it.snippet?.publishedAt || "",
          views: parseInt(it.statistics?.viewCount, 10) || 0,
          durationSec: parseISODuration(it.contentDetails?.duration)
        })
      }
    }
    return out
  }
}
```

- [ ] **Step 4: Запустить тест**

Run: `node --test test/youtube-client.test.js`
Expected: PASS

- [ ] **Step 5: Дописать тесты на токен и квоту**

```javascript
test("the access token is fetched once and reused until it expires", async () => {
	let tokenCalls = 0

	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			if (url.pathname.endsWith("/token")) {
				tokenCalls++
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }))
			}
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ items: [] }))
		},
		async (url) => {
			const client = makeClient(url)
			await client.listVideoDetails(["a"])
			await client.listVideoDetails(["b"])
			assert.equal(tokenCalls, 1, "a valid token must not be re-fetched per request")
		}
	)
})

test("an exhausted quota is not retried", async () => {
	let apiCalls = 0

	await withServer(
		(req, res) => {
			const url = new URL(req.url, "http://x")
			if (url.pathname.endsWith("/token")) {
				res.writeHead(200, { "Content-Type": "application/json" })
				return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }))
			}
			apiCalls++
			res.writeHead(403, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }))
		},
		async (url) => {
			const client = makeClient(url)
			await assert.rejects(() => client.listVideoDetails(["a"]), /quota/i)
			assert.equal(apiCalls, 1, "a daily quota does not come back from a retry")
		}
	)
})

test("a revoked refresh token fails loudly", async () => {
	await withServer(
		(req, res) => {
			res.writeHead(400, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "invalid_grant" }))
		},
		async (url) => {
			const client = makeClient(url)
			await assert.rejects(() => client.getAccessToken(), /OAuth 400/)
		}
	)
})
```

- [ ] **Step 6: Запустить тесты**

Run: `node --test test/youtube-client.test.js`
Expected: PASS (4 теста)

- [ ] **Step 7: Коммит**

```bash
git add src/youtube/client.js test/youtube-client.test.js
git commit -m "Talk to the YouTube API over OAuth in batches"
```

---

### Task 5: Скрипт авторизации

**Files:**
- Create: `src/auth-youtube.js`
- Modify: `package.json` (секция `scripts`), `.env.example`

**Interfaces:**
- Consumes: `YouTubeClient` не используется — скрипт работает с OAuth-эндпоинтом напрямую
- Produces: печатает `YOUTUBE_REFRESH_TOKEN` для вставки в `.env`

Тестов у этой задачи нет: скрипт интерактивный и одноразовый, его проверка — живой прогон.

- [ ] **Step 1: Написать скрипт**

```javascript
// src/auth-youtube.js
import "dotenv/config"
import { createInterface } from "readline"

const clientId = process.env.YOUTUBE_CLIENT_ID
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET

if (!clientId || !clientSecret) {
  console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env")
  console.error("Google Cloud → APIs & Services → Credentials → OAuth client ID → Desktop app")
  process.exit(1)
}

// Out-of-band flow: Google shows the code on screen, no local web server needed.
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob"
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly"

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
authUrl.searchParams.set("client_id", clientId)
authUrl.searchParams.set("redirect_uri", REDIRECT_URI)
authUrl.searchParams.set("response_type", "code")
authUrl.searchParams.set("scope", SCOPE)
authUrl.searchParams.set("access_type", "offline")
authUrl.searchParams.set("prompt", "consent")

const rl = createInterface({ input: process.stdin, output: process.stdout })
const question = (q) => new Promise((res) => rl.question(q, res))

async function main() {
  console.log("\nOpen this URL, grant access, then paste the code back here:\n")
  console.log(authUrl.toString(), "\n")
  const code = (await question("Code: ")).trim()

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
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
  rl.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
```

- [ ] **Step 2: Добавить npm-скрипт**

В `package.json` в `scripts`, рядом с существующим `"auth"`:

```json
"auth:youtube": "node src/auth-youtube.js",
```

- [ ] **Step 3: Добавить переменные в `.env.example`**

```
# --- YouTube (OAuth, Desktop client) ---
# Google Cloud → APIs & Services → Credentials → OAuth client ID → Desktop app
# Enable "YouTube Data API v3" for the project first.
# Then run: npm run auth:youtube
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=
```

- [ ] **Step 4: Проверить, что скрипт стартует и внятно ругается без учётки**

Run: `YOUTUBE_CLIENT_ID= YOUTUBE_CLIENT_SECRET= node src/auth-youtube.js`
Expected: сообщение про Google Cloud и код выхода 1

- [ ] **Step 5: Коммит**

```bash
git add src/auth-youtube.js package.json .env.example
git commit -m "Add a one-off YouTube consent script"
```

---

### Task 6: Коллектор

**Files:**
- Create: `src/youtube/collector.js`
- Modify: `src/db.js` (функции работы с YouTube-каналами)
- Test: `test/youtube-collector.test.js`

**Interfaces:**
- Consumes: `YouTubeClient` (Task 4), `isShort` (Task 2), `upsertVideo` (Task 1)
- Produces:
  - `collectYouTubeVideos({ client, now }): Promise<{ collected, errors, perChannel }>`
  - `getYouTubeChannels(): Array<{ username, external_id }>` в `db.js`
  - `upsertYouTubeChannel(username, externalId, addedBy)`, `markChannelUnsubscribed(username)` в `db.js`

- [ ] **Step 1: Написать падающий тест**

```javascript
// test/youtube-collector.test.js
import { test } from "node:test"
import assert from "node:assert/strict"

process.env.DB_PATH = ":memory:"
const db = await import("../src/db.js")
const { collectYouTubeVideos } = await import("../src/youtube/collector.js")

function fakeClient(overrides = {}) {
	return {
		isReady: () => true,
		listSubscriptions: async () => [{ channelId: "UC1", title: "@chan1" }],
		listUploadPlaylists: async (ids) => new Map(ids.map((id) => [id, `UU${id.slice(2)}`])),
		listPlaylistVideos: async () => [{ videoId: "vid1", publishedAt: "2026-08-29T08:00:00Z" }],
		listVideoDetails: async (ids) => ids.map((id) => ({
			videoId: id,
			title: "Заголовок",
			description: "Описание",
			channelTitle: "@chan1",
			publishedAt: "2026-08-29T08:00:00Z",
			views: 5000,
			durationSec: 600
		})),
		...overrides
	}
}

test("a collected video lands in posts as a yt-source row", async () => {
	const result = await collectYouTubeVideos({ client: fakeClient(), now: new Date("2026-08-29T12:00:00Z") })

	assert.equal(result.collected, 1)
	assert.deepEqual(result.errors, [])

	const stored = db.getVideosInWindow("2026-08-22T12:00:00.000Z")
	assert.equal(stored.length, 1)
	assert.equal(stored[0].source, "yt")
	assert.equal(stored[0].post_id, "vid1")
	assert.equal(stored[0].duration_sec, 600)
	assert.match(stored[0].link, /vid1/)
})

test("shorts are dropped, streams are kept", async () => {
	const client = fakeClient({
		listPlaylistVideos: async () => [
			{ videoId: "short1", publishedAt: "2026-08-29T08:00:00Z" },
			{ videoId: "long1", publishedAt: "2026-08-29T08:00:00Z" }
		],
		listVideoDetails: async (ids) => ids.map((id) => ({
			videoId: id,
			title: "t",
			description: "d",
			channelTitle: "@chan1",
			publishedAt: "2026-08-29T08:00:00Z",
			views: 100,
			durationSec: id === "short1" ? 45 : 7200
		}))
	})

	const result = await collectYouTubeVideos({ client, now: new Date("2026-08-29T12:00:00Z") })
	assert.equal(result.collected, 1, "only the long one is stored")

	const stored = db.getVideosInWindow("2026-08-22T12:00:00.000Z")
	assert.ok(stored.some((v) => v.post_id === "long1"))
	assert.ok(!stored.some((v) => v.post_id === "short1"))
})

test("one failing channel does not abort the rest", async () => {
	const client = fakeClient({
		listSubscriptions: async () => [
			{ channelId: "UC1", title: "@chan1" },
			{ channelId: "UC2", title: "@chan2" }
		],
		listPlaylistVideos: async (playlistId) => {
			if (playlistId === "UU1") throw new Error("404 playlist not found")
			return [{ videoId: "ok1", publishedAt: "2026-08-29T08:00:00Z" }]
		}
	})

	const result = await collectYouTubeVideos({ client, now: new Date("2026-08-29T12:00:00Z") })
	assert.equal(result.errors.length, 1)
	assert.ok(result.collected >= 1, "the healthy channel still got collected")
})

test("an unconfigured client collects nothing and does not throw", async () => {
	const result = await collectYouTubeVideos({ client: fakeClient({ isReady: () => false }) })
	assert.equal(result.collected, 0)
	assert.deepEqual(result.perChannel, [])
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/youtube-collector.test.js`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Добавить функции каналов и окна в `src/db.js`**

```javascript
export function getYouTubeChannels() {
  return db.prepare(
    "SELECT username, external_id FROM channels WHERE source = 'yt' AND unsubscribed_at IS NULL"
  ).all()
}

export function upsertYouTubeChannel(username, externalId, addedBy) {
  db.prepare(
    `INSERT INTO channels (username, added_by, source, external_id)
     VALUES (?, ?, 'yt', ?)
     ON CONFLICT(username) DO UPDATE SET
       external_id = excluded.external_id,
       unsubscribed_at = NULL`
  ).run(username, addedBy || 0, externalId)
}

export function markChannelUnsubscribed(username) {
  db.prepare(
    "UPDATE channels SET unsubscribed_at = datetime('now') WHERE username = ? AND source = 'yt'"
  ).run(username)
}

export function getVideosInWindow(sinceIso) {
  return db.prepare(
    `SELECT id, channel, post_id, text, link, views, date, source, duration_sec
     FROM posts WHERE source = 'yt' AND date >= ? ORDER BY date DESC`
  ).all(sinceIso)
}
```

- [ ] **Step 4: Реализовать коллектор**

```javascript
// src/youtube/collector.js
import { v4 as uuidv4 } from "uuid"
import { isShort } from "./duration.js"
import {
  getYouTubeChannels,
  upsertYouTubeChannel,
  markChannelUnsubscribed,
  upsertVideo
} from "../db.js"

const WINDOW_DAYS = 7

/**
 * Собирает видео с подписок за окно. Список подписок синхронизируется каждый
 * прогон: новые каналы добавляются, отписки помечаются, но не удаляются —
 * их прошлые видео нужны для медианы канала и для post_feedback.
 */
export async function collectYouTubeVideos({ client, now = new Date(), addedBy = 0 } = {}) {
  const errors = []
  const perChannel = []

  if (!client || !client.isReady()) {
    console.log("[collectYouTubeVideos] YouTube not configured, skipping.")
    return { collected: 0, errors, perChannel }
  }

  try {
    await syncSubscriptions(client, addedBy)
  } catch (e) {
    errors.push(`subscriptions: ${e.message}`)
  }

  const channels = getYouTubeChannels()
  if (channels.length === 0) {
    return { collected: 0, errors, perChannel }
  }

  const sinceIso = new Date(now.getTime() - WINDOW_DAYS * 86400_000).toISOString()
  const pending = []

  for (const ch of channels) {
    if (!ch.external_id) continue
    try {
      const videos = await client.listPlaylistVideos(ch.external_id, sinceIso)
      for (const v of videos) pending.push({ ...v, channel: ch.username })
      perChannel.push({ channel: ch.username, count: videos.length })
    } catch (e) {
      errors.push(`${ch.username}: ${e.message}`)
      perChannel.push({ channel: ch.username, count: 0, error: e.message })
    }
  }

  if (pending.length === 0) return { collected: 0, errors, perChannel }

  let details = []
  try {
    details = await client.listVideoDetails(pending.map((p) => p.videoId))
  } catch (e) {
    errors.push(`videos: ${e.message}`)
    return { collected: 0, errors, perChannel }
  }

  const channelByVideo = new Map(pending.map((p) => [p.videoId, p.channel]))
  let collected = 0

  for (const d of details) {
    if (isShort(d.durationSec)) continue
    const channel = channelByVideo.get(d.videoId)
    if (!channel) continue
    const text = d.description ? `${d.title}\n\n${d.description}` : d.title
    upsertVideo(
      uuidv4(),
      channel,
      d.videoId,
      text,
      `https://www.youtube.com/watch?v=${d.videoId}`,
      d.views,
      d.durationSec,
      d.publishedAt
    )
    collected++
  }

  console.log(`[collectYouTubeVideos] Finished. Total: ${collected} videos, ${errors.length} errors.`)
  return { collected, errors, perChannel }
}

async function syncSubscriptions(client, addedBy) {
  const subs = await client.listSubscriptions()
  if (subs.length === 0) return

  const known = new Map(getYouTubeChannels().map((c) => [c.username, c]))
  const seen = new Set()

  const missingPlaylists = []
  for (const s of subs) {
    const username = `yt:${s.title}`
    seen.add(username)
    if (!known.has(username) || !known.get(username).external_id) {
      missingPlaylists.push({ username, channelId: s.channelId })
    }
  }

  if (missingPlaylists.length > 0) {
    const uploads = await client.listUploadPlaylists(missingPlaylists.map((m) => m.channelId))
    for (const m of missingPlaylists) {
      const playlist = uploads.get(m.channelId)
      if (playlist) upsertYouTubeChannel(m.username, playlist, addedBy)
    }
  }

  for (const username of known.keys()) {
    if (!seen.has(username)) markChannelUnsubscribed(username)
  }
}
```

- [ ] **Step 5: Запустить тесты**

Run: `node --test test/youtube-collector.test.js`
Expected: PASS (4 теста)

- [ ] **Step 6: Прогнать весь набор**

Run: `npm test`
Expected: PASS — все предыдущие тесты не сломаны

- [ ] **Step 7: Коммит**

```bash
git add src/youtube/collector.js src/db.js test/youtube-collector.test.js
git commit -m "Collect videos from subscriptions into posts"
```

---

### Task 7: Встроить сбор в cron

**Files:**
- Modify: `src/cron-job.js:26-47` (функция `runCollection`)
- Test: `test/youtube-collector.test.js` (дописать)

**Interfaces:**
- Consumes: `collectYouTubeVideos` (Task 6), `YouTubeClient` (Task 4)
- Produces: ничего для последующих задач

- [ ] **Step 1: Написать тест на изоляцию**

Тест проверяет главное требование спеки: упавший YouTube не отменяет собранные телеграмные посты.

```javascript
test("a thrown YouTube collector still returns a result envelope", async () => {
	const client = fakeClient({
		listSubscriptions: async () => { throw new Error("network is down") },
		listPlaylistVideos: async () => { throw new Error("network is down") }
	})

	const result = await collectYouTubeVideos({ client, now: new Date("2026-08-29T12:00:00Z") })
	assert.ok(result.errors.length > 0, "the failure is reported")
	assert.equal(typeof result.collected, "number", "the caller always gets a usable envelope")
})
```

- [ ] **Step 2: Запустить — должен пройти сразу**

Run: `node --test test/youtube-collector.test.js`
Expected: PASS — коллектор уже ловит ошибки внутри. Если падает, значит в Task 6 потерян `try/catch` вокруг канала.

- [ ] **Step 3: Встроить в `runCollection`**

В `src/cron-job.js` добавить импорты сверху:

```javascript
import { collectYouTubeVideos } from "./youtube/collector.js"
import { YouTubeClient } from "./youtube/client.js"
```

Внутри `runCollection`, сразу после лога о собранных телеграмных постах и перед `console.log("[cron-job] Completed successfully.")`:

```javascript
    // YouTube не имеет права отменить уже собранные посты, поэтому свой try/catch.
    try {
      const yt = await collectYouTubeVideos({
        client: new YouTubeClient(),
        addedBy: parseInt(process.env.ADMIN_ID, 10) || 0
      })
      if (yt.errors.length) console.error("[cron-job] YouTube errors:", yt.errors)
      console.log(`[cron-job] Collected ${yt.collected} videos.`)
    } catch (e) {
      console.error("[cron-job] YouTube collection failed:", e.message)
    }
```

- [ ] **Step 4: Проверить синтаксис**

Run: `node --check src/cron-job.js`
Expected: без вывода

- [ ] **Step 5: Прогнать сбор вживую с пустой конфигурацией**

Run: `node src/cron-job.js --action=collect`
Expected: телеграмный сбор отрабатывает как раньше; в логе `YouTube not configured, skipping.`; код выхода 0

- [ ] **Step 6: Коммит**

```bash
git add src/cron-job.js test/youtube-collector.test.js
git commit -m "Collect YouTube alongside Telegram without coupling them"
```

---

### Task 8: Отбор видео для дайджеста

**Files:**
- Modify: `src/db.js` (новый запрос отбора), `src/services/BotService.js` (метод отбора)
- Test: `test/digest-video.test.js` (дописать)

**Interfaces:**
- Consumes: `getShownPostIds`, `getVideosInWindow` (Task 1, 6), `median`, `computeBoost` (Task 3)
- Produces: `BotService.selectVideosForDigest(userId, { limit, now }): Promise<{ videos: Array<post>, remaining: number }>`

- [ ] **Step 1: Написать падающий тест**

```javascript
test("the same video is not offered twice", async () => {
	// Медиана канала: 5 созревших видео по 1000 просмотров
	for (let i = 0; i < 5; i++) {
		db.upsertVideo(`m${i}`, "yt:@c", `mature${i}`, "старое", "https://youtube.com/watch?v=x", 1000, 600,
			new Date(Date.now() - (10 + i) * 86400_000).toISOString())
	}
	db.upsertVideo("fresh1", "yt:@c", "freshA", "свежее А", "https://youtube.com/watch?v=a", 20000, 600,
		new Date(Date.now() - 86400_000).toISOString())
	db.upsertVideo("fresh2", "yt:@c", "freshB", "свежее Б", "https://youtube.com/watch?v=b", 15000, 600,
		new Date(Date.now() - 86400_000).toISOString())

	const first = db.getVideoCandidates(7, new Set())
	assert.equal(first.length, 2, "both fresh videos are candidates, matured ones are outside the window")

	const second = db.getVideoCandidates(7, new Set(["fresh1"]))
	assert.ok(!second.some((v) => v.id === "fresh1"), "a shown video drops out of the pool")
})

test("the channel norm comes from matured videos only", () => {
	const norms = db.getChannelViewNorms(7, 90)
	const norm = norms.get("yt:@c")
	assert.ok(norm, "the channel has a norm")
	assert.equal(norm.maturedCount, 5)
	assert.equal(norm.medianViews, 1000, "fresh 20k and 15k videos must not drag the norm up")
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/digest-video.test.js`
Expected: FAIL — `db.getVideoCandidates is not a function`

- [ ] **Step 3: Добавить запросы в `src/db.js`**

```javascript
/** Видео за окно, не скрытые пользователем. Показанные отсеиваются вызывающим. */
export function getVideoCandidates(windowDays, shownIds, userId = null) {
  const since = new Date(Date.now() - windowDays * 86400_000).toISOString()
  const rows = db.prepare(
    `SELECT p.id, p.channel, p.post_id, p.text, p.link, p.views, p.date, p.source, p.duration_sec
     FROM posts p
     WHERE p.source = 'yt' AND p.date >= ?
       AND (? IS NULL OR NOT EXISTS (
         SELECT 1 FROM user_channel_settings ucs
         WHERE ucs.user_id = ? AND ucs.channel = p.channel AND ucs.hidden = 1
       ))
     ORDER BY p.date DESC`
  ).all(since, userId, userId)
  return rows.filter((r) => !shownIds.has(r.id))
}

/** Медиана просмотров по созревшим видео каждого канала — норма для boost. */
export function getChannelViewNorms(minAgeDays, maxAgeDays) {
  const newest = new Date(Date.now() - minAgeDays * 86400_000).toISOString()
  const oldest = new Date(Date.now() - maxAgeDays * 86400_000).toISOString()
  const rows = db.prepare(
    `SELECT channel, views FROM posts
     WHERE source = 'yt' AND date <= ? AND date >= ?`
  ).all(newest, oldest)

  const byChannel = new Map()
  for (const r of rows) {
    if (!byChannel.has(r.channel)) byChannel.set(r.channel, [])
    byChannel.get(r.channel).push(r.views || 0)
  }

  const norms = new Map()
  for (const [channel, views] of byChannel) {
    const sorted = [...views].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const medianViews = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid]
    norms.set(channel, { medianViews, maturedCount: sorted.length })
  }
  return norms
}
```

- [ ] **Step 4: Запустить тесты**

Run: `node --test test/digest-video.test.js`
Expected: PASS

- [ ] **Step 5: Добавить отбор в `BotService`**

В `src/services/BotService.js` (табы!), рядом с другими методами:

```javascript
	/**
	 * Топ видео за скользящее окно. Показанные лежат в digest_shown, поэтому
	 * повторный вызов естественно отдаёт следующие — хвост нигде не хранится.
	 */
	async selectVideosForDigest(userId, { limit = VIDEO_LEAD_COUNT } = {}) {
		const shown = getShownPostIds(userId)
		const candidates = getVideoCandidates(VIDEO_WINDOW_DAYS, shown, userId)
		if (candidates.length === 0) return { videos: [], remaining: 0 }

		const user = getOrCreateUser(userId)
		const ranked = await this.mgr.ai.rankPosts(candidates, user.profile || "")
		const scoreById = new Map(ranked.map((r) => [String(r.post_id), Number(r.score) || 0]))
		const norms = getChannelViewNorms(VIDEO_NORM_MIN_AGE_DAYS, VIDEO_NORM_MAX_AGE_DAYS)

		const scored = candidates.map((v) => {
			const norm = norms.get(v.channel) || { medianViews: 0, maturedCount: 0 }
			const boost = computeBoost(v.views, norm.medianViews, norm.maturedCount)
			return { video: v, score: (scoreById.get(v.id) || 0) * (1 + boost) }
		}).sort((a, b) => b.score - a.score)

		const capped = scored.slice(0, VIDEO_DAILY_CAP)
		return {
			videos: capped.slice(0, limit).map((s) => s.video),
			remaining: Math.max(0, capped.length - limit)
		}
	}
```

Константы — рядом с другими константами в начале файла:

```javascript
const VIDEO_WINDOW_DAYS = 7
const VIDEO_LEAD_COUNT = 3
const VIDEO_DAILY_CAP = 10
const VIDEO_NORM_MIN_AGE_DAYS = 7
const VIDEO_NORM_MAX_AGE_DAYS = 90
```

Импорты — добавить в существующий блок импортов из `../db.js`: `getShownPostIds`, `markDigestShown`, `getVideoCandidates`, `getChannelViewNorms`. И новый импорт: `import { computeBoost } from "../youtube/scoring.js"`.

- [ ] **Step 6: Проверить синтаксис**

Run: `node --check src/services/BotService.js`
Expected: без вывода

- [ ] **Step 7: Коммит**

```bash
git add src/db.js src/services/BotService.js test/digest-video.test.js
git commit -m "Pick the day's videos from a sliding window"
```

---

### Task 9: Рендер видео-блока и кнопка

**Files:**
- Modify: `src/ui/UIFormatter.js`, `src/ui/KeyboardProvider.js`
- Test: `test/digest-video.test.js` (дописать)

**Interfaces:**
- Consumes: ничего из предыдущих задач
- Produces:
  - `UIFormatter.formatVideoBlockText(block, postById): string`
  - `UIFormatter.formatDuration(sec): string`
  - `UIFormatter.formatViews(views): string`
  - `KeyboardProvider.videoMoreKeyboard(remaining): object | undefined`

- [ ] **Step 1: Написать падающий тест**

```javascript
test("a video block shows the two numbers a viewer decides by", async () => {
	const { UIFormatter } = await import("../src/ui/UIFormatter.js")

	const block = { ids: ["v1"], essence: "Автор разбирает архитектуру воркеров", emoji: "🎬" }
	const postById = {
		v1: { channel: "yt:@chan", postUrl: "https://www.youtube.com/watch?v=abc", duration_sec: 1320, views: 47000 }
	}

	const text = UIFormatter.formatVideoBlockText(block, postById)
	assert.match(text, /22 мин/, "duration in minutes")
	assert.match(text, /47k/, "views abbreviated")
	assert.match(text, /@chan/)
})

test("durations and views read as a human would write them", async () => {
	const { UIFormatter } = await import("../src/ui/UIFormatter.js")
	assert.equal(UIFormatter.formatDuration(90), "2 мин")
	assert.equal(UIFormatter.formatDuration(3600), "1 ч 0 мин")
	assert.equal(UIFormatter.formatDuration(7260), "2 ч 1 мин")
	assert.equal(UIFormatter.formatViews(999), "999")
	assert.equal(UIFormatter.formatViews(47000), "47k")
	assert.equal(UIFormatter.formatViews(1500000), "1.5M")
})

test("no tail means no button", async () => {
	const { KeyboardProvider } = await import("../src/ui/KeyboardProvider.js")
	assert.equal(KeyboardProvider.videoMoreKeyboard(0), undefined)
	const kb = KeyboardProvider.videoMoreKeyboard(7)
	assert.match(kb.reply_markup.inline_keyboard[0][0].text, /Ещё 7/)
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/digest-video.test.js`
Expected: FAIL — `formatVideoBlockText is not a function`

- [ ] **Step 3: Реализовать форматирование**

В `src/ui/UIFormatter.js` (табы!):

```javascript
	static formatDuration(sec) {
		if (!sec || sec <= 0) return ""
		const totalMin = Math.round(sec / 60)
		if (totalMin < 60) return `${totalMin} мин`
		return `${Math.floor(totalMin / 60)} ч ${totalMin % 60} мин`
	}

	static formatViews(views) {
		if (!views || views <= 0) return ""
		if (views < 1000) return String(views)
		if (views < 1_000_000) return `${Math.round(views / 1000)}k`
		return `${(views / 1_000_000).toFixed(1)}M`
	}

	/** Как текстовый блок, но вторая строка несёт длительность и просмотры — по ним решают, открывать ли. */
	static formatVideoBlockText(block, postById) {
		const essence = this.escapeHtml(block.essence)
		const meta = postById[block.ids[0]] || {}
		const safeUrl = String(meta.postUrl || "#").replace(/&/g, "&amp;")
		const channel = this.escapeHtml(String(meta.channel || "").replace(/^yt:/, ""))

		const parts = [
			`<a href="${safeUrl}">▶ ${channel}</a>`,
			this.formatDuration(meta.duration_sec),
			this.formatViews(meta.views)
		].filter(Boolean)

		return `${block.emoji || "🎬"} ${essence}\n\n${parts.join(" · ")}`
	}
```

- [ ] **Step 4: Реализовать кнопку**

В `src/ui/KeyboardProvider.js` (табы!):

```javascript
	static videoMoreKeyboard(remaining) {
		if (!remaining || remaining <= 0) return undefined
		return {
			reply_markup: {
				inline_keyboard: [[
					{ text: `📺 Ещё ${remaining} видео`, callback_data: "video_more" }
				]]
			}
		}
	}
```

- [ ] **Step 5: Запустить тесты**

Run: `node --test test/digest-video.test.js`
Expected: PASS

- [ ] **Step 6: Расширить `buildPostById`, чтобы метаданные доезжали до рендера**

В `src/ui/UIFormatter.js` в `buildPostById` добавить два поля:

```javascript
				return [p.id, { channel: p.channel, postUrl, date: p.date, duration_sec: p.duration_sec, views: p.views }]
```

- [ ] **Step 7: Прогнать весь набор**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Коммит**

```bash
git add src/ui/UIFormatter.js src/ui/KeyboardProvider.js test/digest-video.test.js
git commit -m "Render a video block with its runtime and reach"
```

---

### Task 10: Секция в рассылке и кнопка «Ещё»

**Files:**
- Modify: `src/services/BotService.js` (`sendMorningDigests`), `src/handlers/ActionHandler.js`
- Test: `test/digest-video.test.js` (дописать)

**Interfaces:**
- Consumes: всё предыдущее
- Produces: `BotService.sendVideoSection(telegram, userId, { limit }): Promise<number>` — возвращает число отправленных

- [ ] **Step 1: Написать тест на изоляцию секции**

```javascript
test("a failing video section leaves the text digest sent", async () => {
	const sent = []
	const telegram = {
		sendMessage: async (chatId, text) => { sent.push(text); return { message_id: sent.length } }
	}

	const service = {
		selectVideosForDigest: async () => { throw new Error("AI down") },
		sendVideoSection: (await import("../src/services/BotService.js")).BotService.prototype.sendVideoSection
	}

	const count = await service.sendVideoSection.call(service, telegram, 42, {})
	assert.equal(count, 0, "the section reports nothing sent")
	assert.equal(sent.length, 0, "and sends nothing, rather than throwing into the caller")
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/digest-video.test.js`
Expected: FAIL — `sendVideoSection is not a function`

- [ ] **Step 3: Реализовать отправку секции**

В `src/services/BotService.js`:

```javascript
	/**
	 * Видео-секция изолирована от текстовой: её падение не должно отменять дайджест,
	 * который уже собран и отправлен.
	 */
	async sendVideoSection(telegram, userId, { limit = VIDEO_LEAD_COUNT, withHeader = true } = {}) {
		let picked
		try {
			picked = await this.selectVideosForDigest(userId, { limit })
		} catch (e) {
			console.error("[video section] user", userId, e.message)
			return 0
		}

		if (picked.videos.length === 0) return 0

		const user = getOrCreateUser(userId)
		const label = formatDateLabel(new Date())
		let result
		try {
			result = await this.mgr.ai.generateSummaryBlocks(
				picked.videos, label, user.profile || "", picked.videos.length,
				{ compact: true }
			)
		} catch (e) {
			console.error("[video section] blocks failed for user", userId, e.message)
			return 0
		}

		if (!result.blocks?.length) return 0

		if (withHeader) {
			await telegram.sendMessage(userId, "📺 <b>Посмотреть</b>", { parse_mode: "HTML" })
		}

		const postById = UIFormatter.buildPostById(picked.videos)
		const shownIds = []

		for (const block of result.blocks) {
			const postId = block.ids.length === 1 ? block.ids[0] : null
			const text = UIFormatter.formatVideoBlockText(block, postById)
			const kb = KeyboardProvider.blockKeyboard(postId, false, false, postById[postId]?.channel)
			await telegram.sendMessage(userId, text, {
				parse_mode: "HTML",
				disable_web_page_preview: true,
				...kb
			})
			// Помечаем после успешной отправки: упавшая рассылка не должна съесть
			// видео, которых пользователь не видел.
			if (postId) shownIds.push(postId)
		}

		markDigestShown(userId, shownIds)

		const moreKb = KeyboardProvider.videoMoreKeyboard(picked.remaining)
		if (moreKb) {
			await telegram.sendMessage(userId, "…", { parse_mode: "HTML", ...moreKb })
		}

		return shownIds.length
	}
```

- [ ] **Step 4: Встроить в утреннюю рассылку**

В `sendMorningDigests`, внутри `try` для каждого пользователя, после цикла отправки текстовых блоков и **перед** кнопками оценки дайджеста:

```javascript
				await this.sendVideoSection(botInstance.telegram, u.user_id)
```

Метод не бросает — его собственный `try/catch` уже это гарантирует.

- [ ] **Step 5: Обработчик кнопки**

В `src/handlers/ActionHandler.js`, рядом с другими обработчиками колбэков:

```javascript
	async handleVideoMore(ctx) {
		await ctx.answerCbQuery()
		const userId = ctx.from.id
		const sent = await this.mgr.service.sendVideoSection(ctx.telegram, userId, {
			limit: VIDEO_TAIL_COUNT,
			withHeader: false
		})
		if (sent === 0) await ctx.reply("Больше видео за неделю нет.")
		try {
			await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
		} catch {}
	}
```

Константу `const VIDEO_TAIL_COUNT = 7` объявить в начале `ActionHandler.js`.

Регистрация — в `src/core/BotManager.js`, рядом со строкой 112 (`this.bot.action("digest", ...)`), тем же способом, что и остальные строковые колбэки:

```javascript
		this.bot.action("video_more", (ctx) => act.handleVideoMore(ctx))
```

- [ ] **Step 6: Запустить тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Проверить синтаксис изменённых файлов**

Run: `node --check src/services/BotService.js && node --check src/handlers/ActionHandler.js`
Expected: без вывода

- [ ] **Step 8: Обновить README**

В таблице переменных окружения добавить три строки и упомянуть YouTube в описании источников:

```markdown
| `YOUTUBE_CLIENT_ID` | OAuth client ID (Desktop app) | Yes (if using YouTube) |
| `YOUTUBE_CLIENT_SECRET` | OAuth client secret | Yes (if using YouTube) |
| `YOUTUBE_REFRESH_TOKEN` | Refresh token from `npm run auth:youtube` | Yes (if using YouTube) |
```

- [ ] **Step 9: Коммит**

```bash
git add src/services/BotService.js src/handlers/ActionHandler.js src/core/BotManager.js README.md test/digest-video.test.js
git commit -m "Add a video section with the tail behind a button"
```

---

### Task 11: Живая проверка на проде

**Files:** нет изменений кода — только проверка

Эта задача не покрывается тестами по определению: она проверяет реальные вызовы Google API, которые в тестах замоканы.

- [ ] **Step 1: Убедиться, что учётка заведена**

В Google Cloud должен быть включён **YouTube Data API v3** и создан OAuth client типа **Desktop app**. `YOUTUBE_CLIENT_ID` и `YOUTUBE_CLIENT_SECRET` — в `.env` на проде.

- [ ] **Step 2: Получить refresh-токен**

Run: `npm run auth:youtube`
Открыть URL, выдать доступ, вставить код. Полученную строку `YOUTUBE_REFRESH_TOKEN=…` дописать в `.env` на проде.

- [ ] **Step 3: Задеплоить**

Run: `./deploy-remote.sh`
Expected: `[PM2] tg-digest-bot ✓`

- [ ] **Step 4: Прогнать сбор вживую**

Run на проде: `node src/cron-job.js --action=collect`
Expected: в логе `[collectYouTubeVideos] Finished. Total: N videos, 0 errors.` при N > 0

- [ ] **Step 5: Проверить, что легло в базу**

```sql
SELECT channel, post_id, duration_sec, views, date FROM posts WHERE source = 'yt' ORDER BY date DESC LIMIT 5;
SELECT COUNT(*) FROM posts WHERE source = 'yt' AND duration_sec <= 60;
```

Второй запрос должен вернуть 0 — шортсы отсеяны.

- [ ] **Step 6: Собрать секцию без отправки**

Вызвать `selectVideosForDigest` для своего `user_id` и убедиться, что возвращаются 3 видео и `remaining > 0`. Проверить, что заголовки осмысленные, а не мусор.

- [ ] **Step 7: Проверить, что телеграмный сбор не пострадал**

В том же логе прогона: `[cron-job] Collected N posts` с N, сопоставимым с обычным днём (~50).

---

## Self-Review

**Покрытие спеки:**

| Требование спеки | Задача |
|---|---|
| `posts.source`, `posts.duration_sec` | 1 |
| `channels.source`, `external_id`, `unsubscribed_at` | 1, 6 |
| `digest_shown` | 1 |
| `AND p.source = 'tg'` в существующих запросах | 1 |
| OAuth, `subscriptions.list` | 4, 5, 6 |
| Батчинг по 50 | 4 |
| `403 quotaExceeded` без ретрая | 4 |
| Отозванный refresh-токен | 4 |
| Отсев шортсов, стримы остаются | 2, 6 |
| Окно 7 дней | 6, 8 |
| Медиана 7–90 дней, холодный старт | 3, 8 |
| Boost только вверх, логарифм, потолок | 3 |
| Топ-3 в ленте, хвост до 10 | 8, 10 |
| Хвост не хранится | 8, 10 |
| Блок с длительностью и просмотрами | 9 |
| Кнопка «Ещё N видео», нет хвоста — нет кнопки | 9, 10 |
| `digest_shown` после отправки | 10 |
| Изоляция сбора | 6, 7 |
| Изоляция секции | 10 |
| Нет конфига — тихий пропуск | 6 |
| Живой прогон | 11 |

**Известные допущения, которые исполнитель должен проверить на месте:**

1. **Имя канала для `channels.username`** — берётся из `snippet.title` подписки и префиксуется `yt:`. Если у двух подписок совпадут названия, вторая перезапишет первую по `UNIQUE(username)`. Для одного пользователя это маловероятно; если всплывёт — ключом станет `yt:<channelId>`, а название уйдёт в отдельную колонку.
2. **`generateSummaryBlocks` с `compact: true`** для видео вызывается на 3 или 7 постах — бюджет запроса это выдерживает, но на живом прогоне (Task 11, шаг 6) стоит убедиться, что блоки не обрезаются.
