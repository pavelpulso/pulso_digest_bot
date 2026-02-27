import Database from "better-sqlite3"
import { mkdirSync, existsSync } from "fs"
import { dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

const dbPath = process.env.DB_PATH || "./data/db.sqlite"

function ensureDataDir() {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

ensureDataDir()

const db = new Database(dbPath)

db.pragma("journal_mode = WAL")
db.pragma("foreign_keys = ON")

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    added_by INTEGER NOT NULL,
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    post_id INTEGER NOT NULL,
    text TEXT,
    link TEXT,
    views INTEGER DEFAULT 0,
    date TEXT NOT NULL,
    UNIQUE(channel, post_id)
  );

  CREATE TABLE IF NOT EXISTS rankings (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    post_id TEXT NOT NULL,
    score REAL NOT NULL,
    reason TEXT,
    date TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    profile TEXT,
    is_banned INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date);
  CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel);
  CREATE INDEX IF NOT EXISTS idx_rankings_user_date ON rankings(user_id, date);
`)

// Migration: digest_max_items (default 10)
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name)
if (!userCols.includes("digest_max_items")) {
  db.prepare("ALTER TABLE users ADD COLUMN digest_max_items INTEGER DEFAULT 10").run()
}
if (!userCols.includes("minus_keywords")) {
  db.prepare("ALTER TABLE users ADD COLUMN minus_keywords TEXT").run()
}
if (!userCols.includes("digest_format")) {
  db.prepare("ALTER TABLE users ADD COLUMN digest_format TEXT DEFAULT 'full'").run()
}

// user_channel_settings: per-user hide-in-digest and priority (1=normal, 2=important)
db.exec(`
  CREATE TABLE IF NOT EXISTS user_channel_settings (
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    hidden INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 1,
    PRIMARY KEY (user_id, channel),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ucs_user ON user_channel_settings(user_id);
`)

// post_feedback: like/dislike for personalization (rating: 1 = like, -1 = dislike)
db.exec(`
  CREATE TABLE IF NOT EXISTS post_feedback (
    user_id INTEGER NOT NULL,
    post_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, post_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_post_feedback_user ON post_feedback(user_id);
`)

// Settings
export function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key)
  return row ? row.value : null
}

export function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value))
}

export function isBotOpen() {
  const v = getSetting("is_open")
  return v === null || v === "1"
}

export function setBotOpen(open) {
  setSetting("is_open", open ? "1" : "0")
}

// Channels
export function getChannels() {
  return db.prepare("SELECT id, username, added_by, added_at FROM channels ORDER BY username").all()
}

export function getChannelUsernames() {
  return db.prepare("SELECT username FROM channels").all().map((r) => r.username)
}

export function addChannel(username, addedBy) {
  const normalized = username.replace(/^@/, "").toLowerCase()
  try {
    db.prepare("INSERT INTO channels (username, added_by) VALUES (?, ?)").run(normalized, addedBy)
    return { ok: true, username: normalized }
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return { ok: false, exists: true, username: normalized }
    throw e
  }
}

export function removeChannel(username) {
  const normalized = username.replace(/^@/, "").toLowerCase()
  const r = db.prepare("DELETE FROM channels WHERE username = ?").run(normalized)
  return r.changes > 0
}

export function removeChannelsByUsernames(usernames) {
  const normalized = usernames.map(u => u.replace(/^@/, "").toLowerCase())
  const placeholders = normalized.map(() => "?").join(",")
  const r = db.prepare(`DELETE FROM channels WHERE username IN (${placeholders})`).run(...normalized)
  return r.changes
}

export function hasChannel(username) {
  const normalized = username.replace(/^@/, "").toLowerCase()
  return db.prepare("SELECT 1 FROM channels WHERE username = ?").get(normalized) != null
}

// Posts
export function upsertPost(id, channel, postId, text, link, views, date) {
  db.prepare(
    `INSERT INTO posts (id, channel, post_id, text, link, views, date)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, post_id) DO UPDATE SET
       text = excluded.text,
       link = excluded.link,
       views = excluded.views,
       date = excluded.date`
  ).run(id, channel, postId, text || "", link || "", views || 0, date)
}

export function getPostsLast24h() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  return db.prepare(
    "SELECT id, channel, post_id, text, link, views, date FROM posts WHERE date >= ? ORDER BY date DESC"
  ).all(since)
}

/** Посты за конкретный календарный день (date в формате YYYY-MM-DD). */
export function getPostsForCalendarDay(dateStr) {
  const since = `${dateStr}T00:00:00.000Z`
  const until = new Date(new Date(since).getTime() + 24 * 60 * 60 * 1000).toISOString()
  return db.prepare(
    "SELECT id, channel, post_id, text, link, views, date FROM posts WHERE date >= ? AND date < ? ORDER BY date DESC"
  ).all(since, until)
}

export function getPostById(id) {
  return db.prepare("SELECT id, channel, post_id, text, link, views, date FROM posts WHERE id = ?").get(id)
}

export function getPostsByIds(ids) {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => "?").join(",")
  return db.prepare(
    `SELECT id, channel, post_id, text, link, views, date FROM posts WHERE id IN (${placeholders})`
  ).all(...ids)
}

/** Returns last N posts for a channel (newest first). */
export function getRecentPostsByChannel(channel, limit = 20) {
  const norm = channel.replace(/^@/, "").toLowerCase()
  return db.prepare(
    `SELECT id, channel, post_id, text, link, views, date FROM posts
     WHERE channel = ? ORDER BY date DESC LIMIT ?`
  ).all(norm, limit)
}

// Rankings
export function clearRankingsForUser(userId, date) {
  db.prepare("DELETE FROM rankings WHERE user_id = ? AND date = ?").run(userId, date)
}

export function insertRankings(userId, date, items) {
  if (items.length === 0) return
  const normalized = items.map((it) => ({ ...it, post_id: String(it.post_id).trim() }))
  const postIds = [...new Set(normalized.map((it) => it.post_id))]
  if (postIds.length === 0) return
  const placeholders = postIds.map(() => "?").join(",")
  const selectExisting = db.prepare(`SELECT id FROM posts WHERE id IN (${placeholders})`)
  const insertStmt = db.prepare(
    "INSERT INTO rankings (id, user_id, post_id, score, reason, date) VALUES (?, ?, ?, ?, ?, ?)"
  )
  const tx = db.transaction((list) => {
    const existing = new Set(selectExisting.all(...postIds).map((r) => r.id))
    for (const it of list) {
      if (!existing.has(it.post_id)) continue
      insertStmt.run(it.id, userId, it.post_id, it.score, it.reason || null, date)
    }
  })
  tx(normalized)
}

export function getRankedPostIds(userId, date, limit = 10, offset = 0) {
  const rows = db.prepare(
    "SELECT post_id FROM rankings WHERE user_id = ? AND date = ? ORDER BY score DESC LIMIT ? OFFSET ?"
  ).all(userId, date, limit, offset)
  return rows.map((r) => r.post_id)
}

/** Посты с score >= minScore для дайджеста (только качественные). */
export function getRankedPostIdsAboveScore(userId, date, minScore, limit = 10, offset = 0) {
  const rows = db.prepare(
    "SELECT post_id FROM rankings WHERE user_id = ? AND date = ? AND score >= ? ORDER BY score DESC LIMIT ? OFFSET ?"
  ).all(userId, date, minScore, limit, offset)
  return rows.map((r) => r.post_id)
}

/** Возвращает { postIds, total } для пагинации по rankings. */
export function getRankedPostIdsWithTotal(userId, date, limit = 10, offset = 0, minScore = 0) {
  const rows = db.prepare(
    "SELECT post_id FROM rankings WHERE user_id = ? AND date = ? AND score >= ? ORDER BY score DESC LIMIT ? OFFSET ?"
  ).all(userId, date, minScore, limit, offset)
  const totalRow = db.prepare(
    "SELECT COUNT(*) as total FROM rankings WHERE user_id = ? AND date = ? AND score >= ?"
  ).get(userId, date, minScore)
  return { postIds: rows.map((r) => r.post_id), total: totalRow?.total || 0 }
}

export function getRankingByUserAndPost(userId, postId, date) {
  return db.prepare(
    "SELECT score, reason FROM rankings WHERE user_id = ? AND post_id = ? AND date = ?"
  ).get(userId, postId, date)
}

export function getRankingsMap(userId, date) {
  const rows = db.prepare(
    "SELECT post_id, score, reason FROM rankings WHERE user_id = ? AND date = ?"
  ).all(userId, date)
  const map = {}
  for (const r of rows) map[r.post_id] = { score: r.score, reason: r.reason }
  return map
}

// Post feedback (like/dislike) for personalization
/** Saves or updates feedback. rating: 1 = like, -1 = dislike. */
export function upsertPostFeedback(userId, postId, rating) {
  const r = rating === 1 || rating === "1" ? 1 : -1
  db.prepare(
    `INSERT INTO post_feedback (user_id, post_id, rating) VALUES (?, ?, ?)
     ON CONFLICT(user_id, post_id) DO UPDATE SET rating = excluded.rating, created_at = datetime('now')`
  ).run(userId, postId, r)
  return r
}

/** Returns { liked: string[], disliked: string[] } for last 90 days (for ranking prompt). */
export function getPostFeedbackForRanking(userId) {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const rows = db.prepare(
    "SELECT post_id, rating FROM post_feedback WHERE user_id = ? AND created_at >= ?"
  ).all(userId, since)
  const liked = []
  const disliked = []
  for (const r of rows) {
    if (r.rating === 1) liked.push(r.post_id)
    else disliked.push(r.post_id)
  }
  return { liked, disliked }
}

/** Returns Set of post_id that user already rated (to hide or disable buttons). */
export function getRatedPostIds(userId) {
  const rows = db.prepare("SELECT post_id FROM post_feedback WHERE user_id = ?").all(userId)
  return new Set(rows.map((r) => r.post_id))
}

// Users
const USER_SELECT =
  "SELECT user_id, username, profile, is_banned, updated_at, COALESCE(digest_max_items, 7) AS digest_max_items, minus_keywords, COALESCE(digest_format, 'full') AS digest_format FROM users WHERE user_id = ?"

export function getUser(userId) {
  return db.prepare(USER_SELECT).get(userId)
}

export function getOrCreateUser(userId, username = null) {
  let row = db.prepare(USER_SELECT).get(userId)
  if (!row) {
    db.prepare("INSERT INTO users (user_id, username, profile, is_banned, digest_max_items) VALUES (?, ?, NULL, 0, 7)").run(userId, username)
    row = db.prepare(USER_SELECT).get(userId)
  } else if (username != null) {
    db.prepare("UPDATE users SET username = ?, updated_at = datetime('now') WHERE user_id = ?").run(username, userId)
    row = db.prepare(USER_SELECT).get(userId)
  }
  return row
}

export function updateUserProfile(userId, profile) {
  db.prepare("UPDATE users SET profile = ?, updated_at = datetime('now') WHERE user_id = ?").run(profile, userId)
}

export function updateUserDigestMax(userId, maxItems) {
  const n = Math.min(20, Math.max(3, parseInt(maxItems, 10)))
  if (Number.isNaN(n)) return null
  db.prepare("UPDATE users SET digest_max_items = ?, updated_at = datetime('now') WHERE user_id = ?").run(n, userId)
  return n
}

export function updateUserMinusKeywords(userId, keywordsText) {
  const value = keywordsText == null || String(keywordsText).trim() === "" ? null : String(keywordsText).trim()
  db.prepare("UPDATE users SET minus_keywords = ?, updated_at = datetime('now') WHERE user_id = ?").run(value, userId)
  return value
}

/** @returns {'full'|'compact'} */
export function getDigestFormat(userId) {
  const row = db.prepare("SELECT COALESCE(digest_format, 'full') AS digest_format FROM users WHERE user_id = ?").get(userId)
  const v = row?.digest_format
  return v === "compact" ? "compact" : "full"
}

export function setDigestFormat(userId, format) {
  const v = format === "compact" ? "compact" : "full"
  db.prepare("UPDATE users SET digest_format = ?, updated_at = datetime('now') WHERE user_id = ?").run(v, userId)
  return v
}

/** @returns {string[]} list of keywords (comma-separated in DB) */
export function getUserMinusKeywords(userId) {
  const row = db.prepare("SELECT minus_keywords FROM users WHERE user_id = ?").get(userId)
  const raw = row?.minus_keywords
  if (!raw || typeof raw !== "string") return []
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** @returns {string[]} channel usernames hidden from digest for this user */
export function getUserHiddenChannels(userId) {
  const rows = db.prepare(
    "SELECT channel FROM user_channel_settings WHERE user_id = ? AND hidden = 1"
  ).all(userId)
  return rows.map((r) => r.channel)
}

/** @returns {Record<string, number>} channel -> priority (1=normal, 2=important) */
export function getUserChannelPriorities(userId) {
  const rows = db.prepare(
    "SELECT channel, priority FROM user_channel_settings WHERE user_id = ? AND priority = 2"
  ).all(userId)
  const map = {}
  for (const r of rows) map[r.channel] = 2
  return map
}

export function setUserChannelHidden(userId, channel, hidden) {
  const norm = channel.replace(/^@/, "").toLowerCase()
  db.prepare(
    `INSERT INTO user_channel_settings (user_id, channel, hidden, priority) VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id, channel) DO UPDATE SET hidden = excluded.hidden`
  ).run(userId, norm, hidden ? 1 : 0)
}

export function setUserChannelPriority(userId, channel, priority) {
  const norm = channel.replace(/^@/, "").toLowerCase()
  const p = priority === 2 || priority === "important" ? 2 : 1
  db.prepare(
    `INSERT INTO user_channel_settings (user_id, channel, hidden, priority) VALUES (?, ?, 0, ?)
     ON CONFLICT(user_id, channel) DO UPDATE SET priority = excluded.priority`
  ).run(userId, norm, p)
}

/** Toggle hidden: returns new state (true/false). */
export function toggleUserChannelHidden(userId, channel) {
  const norm = channel.replace(/^@/, "").toLowerCase()
  const row = db.prepare("SELECT hidden FROM user_channel_settings WHERE user_id = ? AND channel = ?").get(userId, norm)
  const next = row ? (row.hidden === 1 ? 0 : 1) : 1
  setUserChannelHidden(userId, norm, next === 1)
  return next === 1
}

/** Cycle priority 1 -> 2 -> 1; returns new priority (1 or 2). */
export function cycleUserChannelPriority(userId, channel) {
  const norm = channel.replace(/^@/, "").toLowerCase()
  const row = db.prepare("SELECT priority FROM user_channel_settings WHERE user_id = ? AND channel = ?").get(userId, norm)
  const current = row?.priority === 2 ? 2 : 1
  const next = current === 2 ? 1 : 2
  setUserChannelPriority(userId, norm, next)
  return next
}

/** @returns {Record<string, { hidden: boolean, priority: number }>} channel -> settings */
export function getUserChannelSettings(userId) {
  const rows = db.prepare(
    "SELECT channel, hidden, priority FROM user_channel_settings WHERE user_id = ?"
  ).all(userId)
  const map = {}
  for (const r of rows) {
    map[r.channel] = { hidden: r.hidden === 1, priority: r.priority === 2 ? 2 : 1 }
  }
  return map
}

export function isUserBanned(userId) {
  const row = db.prepare("SELECT is_banned FROM users WHERE user_id = ?").get(userId)
  return row ? row.is_banned === 1 : false
}

export function setUserBanned(userId, banned) {
  db.prepare("UPDATE users SET is_banned = ?, updated_at = datetime('now') WHERE user_id = ?").run(banned ? 1 : 0, userId)
}

function resolveUserByUsernameOrId(identifier) {
  const raw = String(identifier).trim().replace(/^@/, "")
  const asId = parseInt(raw, 10)
  if (!Number.isNaN(asId)) {
    const row = db.prepare("SELECT user_id FROM users WHERE user_id = ?").get(asId)
    if (row) return row.user_id
  }
  const byUsername = db.prepare("SELECT user_id FROM users WHERE username = ?").get(raw.toLowerCase())
  return byUsername ? byUsername.user_id : null
}

export function banUserByUsernameOrId(identifier) {
  const userId = resolveUserByUsernameOrId(identifier)
  if (userId == null) return { ok: false }
  setUserBanned(userId, true)
  return { ok: true, user_id: userId }
}

export function unbanUserByUsernameOrId(identifier) {
  const userId = resolveUserByUsernameOrId(identifier)
  if (userId == null) return { ok: false }
  setUserBanned(userId, false)
  return { ok: true, user_id: userId }
}

// Stats (admin)
export function getStats() {
  const users = db.prepare("SELECT COUNT(*) AS c FROM users").get()
  const channels = db.prepare("SELECT COUNT(*) AS c FROM channels").get()
  const posts = db.prepare("SELECT COUNT(*) AS c FROM posts").get()
  return {
    users: users.c,
    channels: channels.c,
    posts: posts.c
  }
}

/** Users that should receive morning digest (not banned). */
export function getUsersForMorningDigest() {
  return db.prepare("SELECT user_id, profile FROM users WHERE is_banned = 0").all()
}

export function getPostsForDateRange(since, until) {
  return db.prepare(
    "SELECT id, channel, post_id, text, link, views, date FROM posts WHERE date >= ? AND date < ? ORDER BY date DESC"
  ).all(since, until)
}

export default db
