import Database from "better-sqlite3"
import { mkdirSync, existsSync } from "fs"
import { dirname } from "path"
import { median } from "./youtube/scoring.js"

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

/** Два процесса могут стартовать на одном деплое: проигравший гонки видит колонку уже добавленной. */
function addColumn(sql) {
  try {
    db.prepare(sql).run()
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e
  }
}

// Migration: digest_max_items (default 10)
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name)
if (!userCols.includes("digest_max_items")) {
  addColumn("ALTER TABLE users ADD COLUMN digest_max_items INTEGER DEFAULT 10")
}
if (!userCols.includes("minus_keywords")) {
  addColumn("ALTER TABLE users ADD COLUMN minus_keywords TEXT")
}
if (!userCols.includes("digest_format")) {
  addColumn("ALTER TABLE users ADD COLUMN digest_format TEXT DEFAULT 'full'")
}

// Migration: system_prompt_url, system_prompt_cached, system_prompt_cached_at
if (!userCols.includes("system_prompt_url")) {
  addColumn("ALTER TABLE users ADD COLUMN system_prompt_url TEXT")
}
if (!userCols.includes("system_prompt_cached")) {
  addColumn("ALTER TABLE users ADD COLUMN system_prompt_cached TEXT")
}
if (!userCols.includes("system_prompt_cached_at")) {
  addColumn("ALTER TABLE users ADD COLUMN system_prompt_cached_at TEXT")
}

// Migration: digest_pause_until — pause morning digest until date (ISO string)
if (!userCols.includes("digest_pause_until")) {
  addColumn("ALTER TABLE users ADD COLUMN digest_pause_until TEXT")
}

// Migration: digest_pause_weekends — pause morning digest on Sat/Sun (0/1)
if (!userCols.includes("digest_pause_weekends")) {
  addColumn("ALTER TABLE users ADD COLUMN digest_pause_weekends INTEGER DEFAULT 0")
}

// Migration: onboarding_completed — whether user completed onboarding tour
if (!userCols.includes("onboarding_completed")) {
  addColumn("ALTER TABLE users ADD COLUMN onboarding_completed INTEGER DEFAULT 0")
}

// Migration: posts.source / posts.duration_sec — split telegram posts from videos
const postCols = db.prepare("PRAGMA table_info(posts)").all().map((c) => c.name)
if (!postCols.includes("source")) {
  addColumn("ALTER TABLE posts ADD COLUMN source TEXT NOT NULL DEFAULT 'tg'")
}
if (!postCols.includes("duration_sec")) {
  addColumn("ALTER TABLE posts ADD COLUMN duration_sec INTEGER")
}

// Migration: channels.source / channels.external_id / channels.unsubscribed_at
const channelCols = db.prepare("PRAGMA table_info(channels)").all().map((c) => c.name)
if (!channelCols.includes("source")) {
  addColumn("ALTER TABLE channels ADD COLUMN source TEXT NOT NULL DEFAULT 'tg'")
}
if (!channelCols.includes("external_id")) {
  addColumn("ALTER TABLE channels ADD COLUMN external_id TEXT")
}
if (!channelCols.includes("unsubscribed_at")) {
  addColumn("ALTER TABLE channels ADD COLUMN unsubscribed_at TEXT")
}

// Migration: channels.last_video_at / channels.last_checked_at — activity filter for YouTube polling
if (!channelCols.includes("last_video_at")) {
  addColumn("ALTER TABLE channels ADD COLUMN last_video_at TEXT")
}
if (!channelCols.includes("last_checked_at")) {
  addColumn("ALTER TABLE channels ADD COLUMN last_checked_at TEXT")
}

// Migration: rankings.topic — video ranking carries a topic, needed to survive with the score
const rankingCols = db.prepare("PRAGMA table_info(rankings)").all().map((c) => c.name)
if (!rankingCols.includes("topic")) {
  addColumn("ALTER TABLE rankings ADD COLUMN topic TEXT")
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

// Migration: post_feedback.watched_at — liked videos watched later (/liked)
const postFeedbackCols = db.prepare("PRAGMA table_info(post_feedback)").all().map((c) => c.name)
if (!postFeedbackCols.includes("watched_at")) {
  addColumn("ALTER TABLE post_feedback ADD COLUMN watched_at TEXT")
}
if (!postFeedbackCols.includes("source")) {
  addColumn("ALTER TABLE post_feedback ADD COLUMN source TEXT NOT NULL DEFAULT 'bot'")
}

// digest_feedback: overall digest rating (1 = useful, 0 = so-so, -1 = irrelevant)
db.exec(`
  CREATE TABLE IF NOT EXISTS digest_feedback (
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    rating INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_digest_feedback_user ON digest_feedback(user_id);
`)

// user_stats: track digest opens, posts read for personal stats
db.exec(`
  CREATE TABLE IF NOT EXISTS user_stats (
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    digest_opened INTEGER DEFAULT 0,
    posts_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_stats_user ON user_stats(user_id);
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
  return db.prepare("SELECT id, username, added_by, added_at FROM channels WHERE source = 'tg' ORDER BY username").all()
}

export function getChannelUsernames() {
  return db.prepare("SELECT username FROM channels WHERE source = 'tg'").all().map((r) => r.username)
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
    "SELECT id, channel, post_id, text, link, views, date, source, duration_sec FROM posts WHERE date >= ? AND source = 'tg' ORDER BY date DESC"
  ).all(since)
}

/** Posts for a specific calendar day (date in YYYY-MM-DD format). Uses Moscow time (UTC+3). */
export function getPostsForCalendarDay(dateStr) {
  // Convert dateStr (YYYY-MM-DD) to Moscow time range: 00:00 to 23:59:59 MSK
  // Moscow is UTC+3, so we need to convert to UTC for storage comparison
  const moscowDate = new Date(dateStr + "T00:00:00+03:00") // 00:00 MSK
  const since = moscowDate.toISOString() // Convert to UTC
  const until = new Date(moscowDate.getTime() + 24 * 60 * 60 * 1000).toISOString() // Next day 00:00 MSK in UTC

  return db.prepare(
    "SELECT id, channel, post_id, text, link, views, date, source, duration_sec FROM posts WHERE date >= ? AND date < ? AND source = 'tg' ORDER BY date DESC"
  ).all(since, until)
}

export function getPostById(id) {
  return db.prepare("SELECT id, channel, post_id, text, link, views, date, source, duration_sec FROM posts WHERE id = ?").get(id)
}

export function getPostsByIds(ids) {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => "?").join(",")
  return db.prepare(
    `SELECT id, channel, post_id, text, link, views, date, source, duration_sec FROM posts WHERE id IN (${placeholders})`
  ).all(...ids)
}

export function upsertVideo(id, channel, videoId, text, link, views, durationSec, date) {
  // date is not in the UPDATE SET (unlike upsertPost): publish date is immutable,
  // and overwriting it would shift the video inside the selection window on every collection run.
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

/**
 * Channels recently active, plus genuinely new subscriptions (never polled at all) —
 * the daily poll set. A channel that WAS polled and found nothing (last_video_at still
 * NULL but last_checked_at set) is not "new" anymore — it falls to the dormant set below.
 */
export function getActiveYouTubeChannels(activeDays) {
  const since = new Date(Date.now() - activeDays * 86400_000).toISOString()
  return db.prepare(
    `SELECT username, external_id FROM channels
     WHERE source = 'yt' AND unsubscribed_at IS NULL
       AND (last_video_at >= ? OR (last_video_at IS NULL AND last_checked_at IS NULL))`
  ).all(since)
}

/**
 * Dormant channels — old last_video_at, or checked at least once and still nothing found —
 * that haven't been rechecked in a while. Mutually exclusive with getActiveYouTubeChannels.
 */
export function getDormantYouTubeChannelsDueForRecheck(activeDays, recheckDays) {
  const activeSince = new Date(Date.now() - activeDays * 86400_000).toISOString()
  const recheckSince = new Date(Date.now() - recheckDays * 86400_000).toISOString()
  return db.prepare(
    `SELECT username, external_id FROM channels
     WHERE source = 'yt' AND unsubscribed_at IS NULL
       AND (last_video_at < ? OR (last_video_at IS NULL AND last_checked_at IS NOT NULL))
       AND (last_checked_at < ? OR last_checked_at IS NULL)`
  ).all(activeSince, recheckSince)
}

/** Records a poll: last_checked_at always moves; last_video_at only ever moves forward. */
export function updateChannelActivity(username, { lastVideoAt } = {}) {
  const now = new Date().toISOString()
  if (lastVideoAt) {
    db.prepare(
      `UPDATE channels SET last_checked_at = ?,
         last_video_at = CASE WHEN last_video_at IS NULL OR ? > last_video_at THEN ? ELSE last_video_at END
       WHERE username = ? AND source = 'yt'`
    ).run(now, lastVideoAt, lastVideoAt, username)
  } else {
    db.prepare(
      "UPDATE channels SET last_checked_at = ? WHERE username = ? AND source = 'yt'"
    ).run(now, username)
  }
}

export function getVideosInWindow(sinceIso) {
  return db.prepare(
    `SELECT id, channel, post_id, text, link, views, date, source, duration_sec
     FROM posts WHERE source = 'yt' AND date >= ? ORDER BY date DESC`
  ).all(sinceIso)
}

/** Минимальная длительность видео-кандидата — отсекает трейлеры и клипы. */
const MIN_VIDEO_SECONDS = 300

/**
 * Видео за окно, не скрытые пользователем, максимум два на канал — самое просматриваемое
 * и самое длинное (если это одно и то же видео, канал даёт только одну строку).
 * duration_sec IS NULL сортируется SQLite последним в ORDER BY ... DESC, поэтому видео с
 * неизвестной длительностью выигрывает слот "самое длинное" только если больше ничего нет.
 * Показанные отсеиваются вызывающим.
 */
export function getVideoCandidates(windowDays, shownIds, userId = null) {
  const since = new Date(Date.now() - windowDays * 86400_000).toISOString()
  const rows = db.prepare(
    `SELECT id, channel, post_id, text, link, views, date, source, duration_sec FROM (
       SELECT p.*,
         ROW_NUMBER() OVER (PARTITION BY p.channel ORDER BY p.views DESC, p.date DESC, p.id) AS rn_views,
         ROW_NUMBER() OVER (PARTITION BY p.channel ORDER BY p.duration_sec DESC, p.date DESC, p.id) AS rn_duration
       FROM posts p
       WHERE p.source = 'yt' AND p.date >= ?
         AND (p.duration_sec IS NULL OR p.duration_sec >= ?)
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM user_channel_settings ucs
           WHERE ucs.user_id = ? AND ucs.channel = p.channel AND ucs.hidden = 1
         ))
     ) WHERE rn_views = 1 OR rn_duration = 1
     ORDER BY date DESC`
  ).all(since, MIN_VIDEO_SECONDS, userId, userId)
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
    norms.set(channel, { medianViews: median(views), maturedCount: views.length })
  }
  return norms
}

/** Returns last N posts for a channel (newest first). */
export function getRecentPostsByChannel(channel, limit = 20) {
  const norm = channel.replace(/^@/, "").toLowerCase()
  return db.prepare(
    `SELECT id, channel, post_id, text, link, views, date FROM posts
     WHERE channel = ? ORDER BY date DESC LIMIT ?`
  ).all(norm, limit)
}

// Digest shown history (per user)
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

// Rankings
/** Clears one user+date's rankings for posts of a given source (default 'tg'), so clearing
 * the text digest's rankings before a re-rank never wipes same-day video rankings, and vice versa. */
export function clearRankingsForUser(userId, date, source = "tg") {
  db.prepare(
    `DELETE FROM rankings WHERE user_id = ? AND date = ? AND post_id IN (
       SELECT id FROM posts WHERE source = ?
     )`
  ).run(userId, date, source)
}

/** Video rankings are re-ranked from scratch every day, so old rows are pure dead weight.
 * `beforeDate` is exclusive-lower-bound as a YYYY-MM-DD string; callers should pass a cutoff
 * a couple of days back so a late-night run or timezone edge cannot delete rows the current
 * day still reads. Only rankings are pruned — the underlying yt posts stay (the channel view
 * norm needs videos aged 7-90 days), and text-post rankings are untouched. */
export function pruneOldVideoRankings(beforeDate) {
  const result = db.prepare(
    `DELETE FROM rankings WHERE date < ? AND post_id IN (
       SELECT id FROM posts WHERE source = 'yt'
     )`
  ).run(beforeDate)
  return result.changes
}

export function insertRankings(userId, date, items) {
  if (items.length === 0) return
  const normalized = items.map((it) => ({ ...it, post_id: String(it.post_id).trim() }))
  const postIds = [...new Set(normalized.map((it) => it.post_id))]
  if (postIds.length === 0) return
  const placeholders = postIds.map(() => "?").join(",")
  const selectExisting = db.prepare(`SELECT id FROM posts WHERE id IN (${placeholders})`)
  const insertStmt = db.prepare(
    "INSERT INTO rankings (id, user_id, post_id, score, reason, date, topic) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
  const tx = db.transaction((list) => {
    const existing = new Set(selectExisting.all(...postIds).map((r) => r.id))
    console.log(`[insertRankings] items=${list.length} postIds=${postIds.length} existing=${existing.size}`)
    let inserted = 0
    for (const it of list) {
      if (!existing.has(it.post_id)) {
        console.log(`[insertRankings] Skipping post_id=${it.post_id} (not in posts table)`)
        continue
      }
      insertStmt.run(it.id, userId, it.post_id, it.score, it.reason || null, date, it.topic || null)
      inserted++
    }
    console.log(`[insertRankings] Inserted ${inserted} rankings for userId=${userId} date=${date}`)
  })
  tx(normalized)
}

/** Persisted video ranking for a user+date, newest score first — read back instead of re-ranking. */
export function getVideoRankingRows(userId, date) {
  return db.prepare(
    `SELECT r.post_id, r.score, r.reason, r.topic FROM rankings r
     JOIN posts p ON r.post_id = p.id
     WHERE r.user_id = ? AND r.date = ? AND p.source = 'yt'
     ORDER BY r.score DESC`
  ).all(userId, date)
}

export function getRankedPostIds(userId, date, limit = 10, offset = 0) {
  // Debug: check raw rankings without join
  const rawRankings = db.prepare(
    `SELECT post_id, score FROM rankings WHERE user_id = ? AND date = ? ORDER BY score DESC LIMIT ? OFFSET ?`
  ).all(userId, date, limit, offset)
  console.log(`[getRankedPostIds] raw rankings (no join): ${rawRankings.length}, scores: ${rawRankings.map(r => r.score.toFixed(2)).join(', ')}`)
  
  const rows = db.prepare(
    `SELECT r.post_id FROM rankings r
     JOIN posts p ON r.post_id = p.id
     WHERE r.user_id = ? AND r.date = ? AND p.source = 'tg'
       AND NOT EXISTS (
         SELECT 1 FROM user_channel_settings ucs
         WHERE ucs.user_id = ? AND ucs.channel = p.channel AND ucs.hidden = 1
       )
     ORDER BY r.score DESC LIMIT ? OFFSET ?`
  ).all(userId, date, userId, limit, offset)
  console.log(`[getRankedPostIds] after join + hidden filter: ${rows.length}`)
  return rows.map((r) => r.post_id)
}

/** Posts with score >= minScore for digest (high quality only, excludes hidden channels). */
export function getRankedPostIdsAboveScore(userId, date, minScore, limit = 10, offset = 0) {
  const rows = db.prepare(
    `SELECT r.post_id FROM rankings r
     JOIN posts p ON r.post_id = p.id
     WHERE r.user_id = ? AND r.date = ? AND r.score >= ? AND p.source = 'tg'
       AND NOT EXISTS (
         SELECT 1 FROM user_channel_settings ucs
         WHERE ucs.user_id = ? AND ucs.channel = p.channel AND ucs.hidden = 1
       )
     ORDER BY r.score DESC LIMIT ? OFFSET ?`
  ).all(userId, date, minScore, userId, limit, offset)
  return rows.map((r) => r.post_id)
}

/** Returns { postIds, total } for pagination over rankings (excludes hidden channels). */
export function getRankedPostIdsWithTotal(userId, date, limit = 10, offset = 0, minScore = 0) {
  const rows = db.prepare(
    `SELECT r.post_id FROM rankings r
     JOIN posts p ON r.post_id = p.id
     WHERE r.user_id = ? AND r.date = ? AND r.score >= ? AND p.source = 'tg'
       AND NOT EXISTS (
         SELECT 1 FROM user_channel_settings ucs
         WHERE ucs.user_id = ? AND ucs.channel = p.channel AND ucs.hidden = 1
       )
     ORDER BY r.score DESC LIMIT ? OFFSET ?`
  ).all(userId, date, minScore, userId, limit, offset)
  const totalRow = db.prepare(
    `SELECT COUNT(*) as total FROM rankings r
     JOIN posts p ON r.post_id = p.id
     WHERE r.user_id = ? AND r.date = ? AND r.score >= ? AND p.source = 'tg'
       AND NOT EXISTS (
         SELECT 1 FROM user_channel_settings ucs
         WHERE ucs.user_id = ? AND ucs.channel = p.channel AND ucs.hidden = 1
       )`
  ).get(userId, date, minScore, userId)
  return { postIds: rows.map((r) => r.post_id), total: totalRow?.total || 0 }
}

export function getRankingByUserAndPost(userId, postId, date) {
  return db.prepare(
    "SELECT score, reason FROM rankings WHERE user_id = ? AND post_id = ? AND date = ?"
  ).get(userId, postId, date)
}

export function getRankingByUserAndPostLatest(userId, postId) {
  return db.prepare(
    "SELECT score, reason, date FROM rankings WHERE user_id = ? AND post_id = ? ORDER BY date DESC LIMIT 1"
  ).get(userId, postId)
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

/** Records a YouTube-native like as 👍 feedback, matched to posts by video id (source='yt').
 * Never overwrites: if the user already rated the post (bot 👍 or 👎), that was a deliberate
 * judgement and wins over a later YouTube like, so this only inserts where no row exists yet.
 * Also stamps watched_at: a YouTube like is only possible after watching, so the like itself
 * IS the evidence — without this the row would sit in /liked's unwatched queue forever. */
export function recordYouTubeLikes(userId, videoIds) {
  if (!videoIds || videoIds.length === 0) return 0
  const placeholders = videoIds.map(() => "?").join(",")
  const matched = db.prepare(
    `SELECT id FROM posts WHERE source = 'yt' AND post_id IN (${placeholders})`
  ).all(...videoIds)
  if (matched.length === 0) return 0

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO post_feedback (user_id, post_id, rating, source, watched_at)
     VALUES (?, ?, 1, 'youtube', datetime('now'))`
  )
  const tx = db.transaction((rows) => {
    let inserted = 0
    for (const row of rows) {
      if (insertStmt.run(userId, row.id).changes > 0) inserted++
    }
    return inserted
  })
  return tx(matched)
}

/** Of the videos shown in the digest since `sinceIso`, how many were later liked on YouTube
 * (post-shown, source='youtube') — the hit-rate behind /yt_status. */
export function getYouTubeHitRate(userId, sinceIso) {
  const shownRow = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM digest_shown ds
     JOIN posts p ON p.id = ds.post_id
     WHERE ds.user_id = ? AND ds.shown_at >= ? AND p.source = 'yt'`
  ).get(userId, sinceIso)

  const likedRow = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM digest_shown ds
     JOIN posts p ON p.id = ds.post_id
     JOIN post_feedback f ON f.user_id = ds.user_id AND f.post_id = ds.post_id
     WHERE ds.user_id = ? AND ds.shown_at >= ? AND p.source = 'yt'
       AND f.source = 'youtube' AND f.rating = 1 AND f.created_at >= ds.shown_at`
  ).get(userId, sinceIso)

  return { shown: shownRow?.cnt || 0, liked: likedRow?.cnt || 0 }
}

const FEEDBACK_EXAMPLES_PER_SIDE = 8
const FEEDBACK_EXCERPT_CHARS = 140

/** Returns { likedWatched, likedDigest, disliked } excerpts for last 90 days (for ranking
 * prompt). Split by how the like was formed: likedWatched is a YouTube like (source='youtube')
 * — the reader actually watched the video before judging it. likedDigest is a bot 👍
 * (source='bot') — a pre-watch guess about the headline alone. Pooling the two would discard
 * exactly the distinction post_feedback.source exists to capture, so they stay separate groups. */
export function getPostFeedbackForRanking(userId) {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const rows = db.prepare(
    `SELECT f.rating, f.source, p.text
     FROM post_feedback f
     JOIN posts p ON p.id = f.post_id
     WHERE f.user_id = ? AND f.created_at >= ? AND p.text IS NOT NULL AND p.text != ''
     ORDER BY f.created_at DESC`
  ).all(userId, since)

  const likedWatched = []
  const likedDigest = []
  const disliked = []
  for (const r of rows) {
    let target
    if (r.rating !== 1) target = disliked
    else if (r.source === "youtube") target = likedWatched
    else target = likedDigest
    if (target.length >= FEEDBACK_EXAMPLES_PER_SIDE) continue
    target.push(r.text.replace(/\s+/g, " ").trim().slice(0, FEEDBACK_EXCERPT_CHARS))
  }
  return { likedWatched, likedDigest, disliked }
}

/** Returns Set of post_id that user already rated (to hide or disable buttons). */
export function getRatedPostIds(userId) {
  const rows = db.prepare("SELECT post_id FROM post_feedback WHERE user_id = ?").all(userId)
  return new Set(rows.map((r) => r.post_id))
}

/** Liked videos (rating = 1, not yet watched) for /liked, newest feedback first. */
export function getLikedUnwatchedVideos(userId, limit) {
  return db.prepare(
    `SELECT p.id, p.channel, p.text, p.link, p.views, p.duration_sec, f.created_at
     FROM post_feedback f
     JOIN posts p ON p.id = f.post_id
     WHERE f.user_id = ? AND f.rating = 1 AND f.watched_at IS NULL AND p.source = 'yt'
     ORDER BY f.created_at DESC
     LIMIT ?`
  ).all(userId, limit)
}

/** Total count backing getLikedUnwatchedVideos, used to report how many the cap left out. */
export function countLikedUnwatchedVideos(userId) {
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM post_feedback f
     JOIN posts p ON p.id = f.post_id
     WHERE f.user_id = ? AND f.rating = 1 AND f.watched_at IS NULL AND p.source = 'yt'`
  ).get(userId)
  return row?.cnt || 0
}

/** Marks a liked video watched without touching its rating — ranking personalization still reads it. */
export function markVideoWatched(userId, postId) {
  const r = db.prepare(
    "UPDATE post_feedback SET watched_at = datetime('now') WHERE user_id = ? AND post_id = ? AND rating = 1"
  ).run(userId, postId)
  return r.changes > 0
}

// Users
const USER_SELECT =
  "SELECT user_id, username, profile, is_banned, updated_at, COALESCE(digest_max_items, 7) AS digest_max_items, minus_keywords, COALESCE(digest_format, 'full') AS digest_format, system_prompt_url, system_prompt_cached, system_prompt_cached_at, digest_pause_until, digest_pause_weekends, onboarding_completed FROM users WHERE user_id = ?"

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

/** Users that should receive morning digest (not banned, not paused). */
export function getUsersForMorningDigest() {
  const now = new Date().toISOString()
  const dayOfWeek = new Date().getDay() // 0 = Sunday, 6 = Saturday
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6) ? 1 : 0
  
  return db.prepare(
    `SELECT user_id, profile FROM users 
     WHERE is_banned = 0 
       AND (digest_pause_until IS NULL OR digest_pause_until < ?)
       AND (digest_pause_weekends = 0 OR ? = 0)`
  ).all(now, isWeekend)
}

// System Prompt Management
export function updateUserSystemPromptUrl(userId, url) {
  const value = url == null || String(url).trim() === "" ? null : String(url).trim()
  db.prepare("UPDATE users SET system_prompt_url = ?, system_prompt_cached = NULL, system_prompt_cached_at = NULL, updated_at = datetime('now') WHERE user_id = ?").run(value, userId)
  return value
}

export function updateUserSystemPromptCached(userId, prompt, url) {
  const now = new Date().toISOString()
  db.prepare("UPDATE users SET system_prompt_cached = ?, system_prompt_cached_at = ?, system_prompt_url = ?, updated_at = datetime('now') WHERE user_id = ?").run(prompt, now, url, userId)
}

export function clearUserSystemPrompt(userId) {
  db.prepare("UPDATE users SET system_prompt_url = NULL, system_prompt_cached = NULL, system_prompt_cached_at = NULL, updated_at = datetime('now') WHERE user_id = ?").run(userId)
}

export function getPostsForDateRange(since, until) {
  return db.prepare(
    "SELECT id, channel, post_id, text, link, views, date FROM posts WHERE date >= ? AND date < ? AND source = 'tg' ORDER BY date DESC"
  ).all(since, until)
}

// Digest pause management
export function setUserDigestPause(userId, pauseUntilIso) {
  db.prepare("UPDATE users SET digest_pause_until = ?, updated_at = datetime('now') WHERE user_id = ?").run(pauseUntilIso, userId)
}

export function getUserDigestPause(userId) {
  const row = db.prepare("SELECT digest_pause_until FROM users WHERE user_id = ?").get(userId)
  return row?.digest_pause_until || null
}

export function clearUserDigestPause(userId) {
  db.prepare("UPDATE users SET digest_pause_until = NULL, updated_at = datetime('now') WHERE user_id = ?").run(null, userId)
}

export function isUserDigestPaused(userId) {
  const row = db.prepare("SELECT digest_pause_until FROM users WHERE user_id = ?").get(userId)
  if (!row?.digest_pause_until) return false
  const until = new Date(row.digest_pause_until)
  return until > new Date()
}

// Weekend pause setting
export function setUserDigestPauseWeekends(userId, enabled) {
  db.prepare("UPDATE users SET digest_pause_weekends = ?, updated_at = datetime('now') WHERE user_id = ?").run(enabled ? 1 : 0, userId)
}

export function getUserDigestPauseWeekends(userId) {
  const row = db.prepare("SELECT digest_pause_weekends FROM users WHERE user_id = ?").get(userId)
  return (row?.digest_pause_weekends || 0) === 1
}

// Onboarding status
export function setUserOnboardingCompleted(userId, completed) {
  db.prepare("UPDATE users SET onboarding_completed = ?, updated_at = datetime('now') WHERE user_id = ?").run(completed ? 1 : 0, userId)
}

export function isUserOnboardingCompleted(userId) {
  const row = db.prepare("SELECT onboarding_completed FROM users WHERE user_id = ?").get(userId)
  return (row?.onboarding_completed || 0) === 1
}

// Digest feedback (overall rating)
/** rating: 1 = useful, 0 = so-so, -1 = irrelevant */
export function upsertDigestFeedback(userId, date, rating) {
  db.prepare(
    `INSERT INTO digest_feedback (user_id, date, rating) VALUES (?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET rating = excluded.rating, created_at = datetime('now')`
  ).run(userId, date, rating)
}

export function getDigestFeedback(userId, date) {
  const row = db.prepare("SELECT rating FROM digest_feedback WHERE user_id = ? AND date = ?").get(userId, date)
  return row?.rating || null
}

// User stats tracking
export function upsertUserStat(userId, date, stats) {
  const { digest_opened = 0, posts_read = 0 } = stats
  db.prepare(
    `INSERT INTO user_stats (user_id, date, digest_opened, posts_read) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET digest_opened = excluded.digest_opened, posts_read = excluded.posts_read`
  ).run(userId, date, digest_opened, posts_read)
}

export function getUserStats(userId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return db.prepare(
    "SELECT date, digest_opened, posts_read FROM user_stats WHERE user_id = ? AND date >= ? ORDER BY date DESC"
  ).all(userId, since)
}

export function getUserStatsSummary(userId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const row = db.prepare(
    "SELECT SUM(digest_opened) as total_opened, SUM(posts_read) as total_posts FROM user_stats WHERE user_id = ? AND date >= ?"
  ).get(userId, since)
  return {
    digestsOpened: row?.total_opened || 0,
    postsRead: row?.total_posts || 0
  }
}

/** Get top channels by posts read (from feedback/interactions) for user */
export function getUserTopChannels(userId, limit = 5) {
  const rows = db.prepare(
    `SELECT p.channel, COUNT(*) as cnt
     FROM post_feedback pf
     JOIN posts p ON pf.post_id = p.id
     WHERE pf.user_id = ? AND pf.rating = 1
     GROUP BY p.channel
     ORDER BY cnt DESC
     LIMIT ?`
  ).all(userId, limit)
  return rows.map(r => ({ channel: r.channel, count: r.cnt }))
}

export default db
