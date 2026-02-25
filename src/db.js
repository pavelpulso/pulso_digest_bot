import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.DB_PATH || "./data/db.sqlite";

function ensureDataDir() {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

ensureDataDir();

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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
`);

// Migration: digest_max_items (default 10)
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes("digest_max_items")) {
  db.prepare("ALTER TABLE users ADD COLUMN digest_max_items INTEGER DEFAULT 10").run();
}

// Settings
export function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

export function isBotOpen() {
  const v = getSetting("is_open");
  return v === null || v === "1";
}

export function setBotOpen(open) {
  setSetting("is_open", open ? "1" : "0");
}

// Channels
export function getChannels() {
  return db.prepare("SELECT id, username, added_by, added_at FROM channels ORDER BY username").all();
}

export function getChannelUsernames() {
  return db.prepare("SELECT username FROM channels").all().map((r) => r.username);
}

export function addChannel(username, addedBy) {
  const normalized = username.replace(/^@/, "").toLowerCase();
  try {
    db.prepare("INSERT INTO channels (username, added_by) VALUES (?, ?)").run(normalized, addedBy);
    return { ok: true, username: normalized };
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return { ok: false, exists: true, username: normalized };
    throw e;
  }
}

export function removeChannel(username) {
  const normalized = username.replace(/^@/, "").toLowerCase();
  const r = db.prepare("DELETE FROM channels WHERE username = ?").run(normalized);
  return r.changes > 0;
}

export function hasChannel(username) {
  const normalized = username.replace(/^@/, "").toLowerCase();
  return db.prepare("SELECT 1 FROM channels WHERE username = ?").get(normalized) != null;
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
  ).run(id, channel, postId, text || "", link || "", views || 0, date);
}

export function getPostsLast24h() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(
    "SELECT id, channel, post_id, text, link, views, date FROM posts WHERE date >= ? ORDER BY date DESC"
  ).all(since);
}

export function getPostById(id) {
  return db.prepare("SELECT id, channel, post_id, text, link, views, date FROM posts WHERE id = ?").get(id);
}

export function getPostsByIds(ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(
    `SELECT id, channel, post_id, text, link, views, date FROM posts WHERE id IN (${placeholders})`
  ).all(...ids);
}

// Rankings
export function clearRankingsForUser(userId, date) {
  db.prepare("DELETE FROM rankings WHERE user_id = ? AND date = ?").run(userId, date);
}

export function insertRankings(userId, date, items) {
  const insert = db.prepare(
    "INSERT INTO rankings (id, user_id, post_id, score, reason, date) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const tx = db.transaction((list) => {
    for (const it of list) {
      insert.run(it.id, userId, it.post_id, it.score, it.reason || null, date);
    }
  });
  tx(items);
}

export function getRankedPostIds(userId, date, limit = 10, offset = 0) {
  const rows = db.prepare(
    `SELECT post_id FROM rankings WHERE user_id = ? AND date = ? ORDER BY score DESC LIMIT ? OFFSET ?`
  ).all(userId, date, limit, offset);
  return rows.map((r) => r.post_id);
}

export function getRankingByUserAndPost(userId, postId, date) {
  return db.prepare(
    "SELECT score, reason FROM rankings WHERE user_id = ? AND post_id = ? AND date = ?"
  ).get(userId, postId, date);
}

export function getRankingsMap(userId, date) {
  const rows = db.prepare(
    "SELECT post_id, score, reason FROM rankings WHERE user_id = ? AND date = ?"
  ).all(userId, date);
  const map = {};
  for (const r of rows) map[r.post_id] = { score: r.score, reason: r.reason };
  return map;
}

// Users
const USER_SELECT = "SELECT user_id, username, profile, is_banned, updated_at, COALESCE(digest_max_items, 10) AS digest_max_items FROM users WHERE user_id = ?";

export function getUser(userId) {
  return db.prepare(USER_SELECT).get(userId);
}

export function getOrCreateUser(userId, username = null) {
  let row = db.prepare(USER_SELECT).get(userId);
  if (!row) {
    db.prepare("INSERT INTO users (user_id, username, profile, is_banned, digest_max_items) VALUES (?, ?, NULL, 0, 10)").run(userId, username);
    row = db.prepare(USER_SELECT).get(userId);
  } else if (username != null) {
    db.prepare("UPDATE users SET username = ?, updated_at = datetime('now') WHERE user_id = ?").run(username, userId);
    row = db.prepare(USER_SELECT).get(userId);
  }
  return row;
}

export function updateUserProfile(userId, profile) {
  db.prepare("UPDATE users SET profile = ?, updated_at = datetime('now') WHERE user_id = ?").run(profile, userId);
}

export function updateUserDigestMax(userId, maxItems) {
  const n = Math.min(20, Math.max(3, parseInt(maxItems, 10)));
  if (Number.isNaN(n)) return null;
  db.prepare("UPDATE users SET digest_max_items = ?, updated_at = datetime('now') WHERE user_id = ?").run(n, userId);
  return n;
}

export function isUserBanned(userId) {
  const row = db.prepare("SELECT is_banned FROM users WHERE user_id = ?").get(userId);
  return row ? row.is_banned === 1 : false;
}

export function setUserBanned(userId, banned) {
  db.prepare("UPDATE users SET is_banned = ?, updated_at = datetime('now') WHERE user_id = ?").run(banned ? 1 : 0, userId);
}

function resolveUserByUsernameOrId(identifier) {
  const raw = String(identifier).trim().replace(/^@/, "");
  const asId = parseInt(raw, 10);
  if (!Number.isNaN(asId)) {
    const row = db.prepare("SELECT user_id FROM users WHERE user_id = ?").get(asId);
    if (row) return row.user_id;
  }
  const byUsername = db.prepare("SELECT user_id FROM users WHERE username = ?").get(raw.toLowerCase());
  return byUsername ? byUsername.user_id : null;
}

export function banUserByUsernameOrId(identifier) {
  const userId = resolveUserByUsernameOrId(identifier);
  if (userId == null) return { ok: false };
  setUserBanned(userId, true);
  return { ok: true, user_id: userId };
}

export function unbanUserByUsernameOrId(identifier) {
  const userId = resolveUserByUsernameOrId(identifier);
  if (userId == null) return { ok: false };
  setUserBanned(userId, false);
  return { ok: true, user_id: userId };
}

// Stats (admin)
export function getStats() {
  const users = db.prepare("SELECT COUNT(*) AS c FROM users").get();
  const channels = db.prepare("SELECT COUNT(*) AS c FROM channels").get();
  const posts = db.prepare("SELECT COUNT(*) AS c FROM posts").get();
  return {
    users: users.c,
    channels: channels.c,
    posts: posts.c
  };
}

export function getPostsForDateRange(since, until) {
  return db.prepare(
    "SELECT id, channel, post_id, text, link, views, date FROM posts WHERE date >= ? AND date < ? ORDER BY date DESC"
  ).all(since, until);
}

export default db;
