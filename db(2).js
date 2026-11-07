// Luminio AI - persistent storage layer (SQLite via better-sqlite3)
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, 'luminio.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  preferences TEXT NOT NULL DEFAULT '{}',
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT NOT NULL DEFAULT 'luminio-3',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  image TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model, day)
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const now = () => Date.now();
const dayStr = (t) => new Date(t || Date.now()).toISOString().slice(0, 10);

const stmts = {
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (id,email,name,avatar,plan,created_at) VALUES (?,?,?,?,\'free\',?)'),
  updateUserProfile: db.prepare('UPDATE users SET name = ?, avatar = ? WHERE id = ?'),
  updateUserName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  updatePrefs: db.prepare('UPDATE users SET preferences = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  listConversations: db.prepare(`SELECT c.*,
      (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
    FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC`),
  getConversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
  insertConversation: db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)'),
  touchConversation: db.prepare('UPDATE conversations SET updated_at = ?, title = COALESCE(?, title) WHERE id = ?'),
  setConversationModel: db.prepare('UPDATE conversations SET model = ? WHERE id = ?'),
  renameConversation: db.prepare('UPDATE conversations SET title = ? WHERE id = ?'),
  deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),
  deleteMessages: db.prepare('DELETE FROM messages WHERE conversation_id = ?'),
  insertMessage: db.prepare('INSERT INTO messages (id,conversation_id,role,content,image,created_at) VALUES (?,?,?,?,?,?)'),
  getMessages: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'),
  getUsage: db.prepare('SELECT * FROM usage WHERE user_id = ? AND model = ? AND day = ?'),
  bumpUsage: db.prepare(`INSERT INTO usage (user_id,model,day,count) VALUES (?,?,?,1)
    ON CONFLICT(user_id,model,day) DO UPDATE SET count = count + 1`),
  getConfig: db.prepare('SELECT value FROM config WHERE key = ?'),
  setConfig: db.prepare(`INSERT INTO config (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  countConversations: db.prepare('SELECT COUNT(*) AS n FROM conversations'),
  countMessages: db.prepare('SELECT COUNT(*) AS n FROM messages'),
  countMessagesSince: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?'),
  usageSince: db.prepare(`SELECT model, day, SUM(count) AS total FROM usage WHERE day >= ? GROUP BY model, day ORDER BY day ASC`),
  planDistribution: db.prepare('SELECT plan, COUNT(*) AS n FROM users GROUP BY plan'),
  recentUsers: db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 100'),
  setUserPlan: db.prepare('UPDATE users SET plan = ? WHERE id = ?'),
  setUserBanned: db.prepare('UPDATE users SET banned = ? WHERE id = ?'),
  resetUsage: db.prepare('DELETE FROM usage WHERE user_id = ?'),
};

function upsertUser({ sub, email, name, avatar }) {
  // Match by email so returning users always get their existing account back.
  // This is the fix for "invalid login when logging in again": the account is
  // looked up by email and updated in place, never duplicated or rejected.
  const existing = stmts.getUserByEmail.get(email);
  if (existing) {
    stmts.updateUserProfile.run(name || existing.name, avatar || existing.avatar, existing.id);
    return { ...existing, name: name || existing.name, avatar: avatar || existing.avatar };
  }
  const id = sub || crypto.randomUUID();
  stmts.insertUser.run(id, email, name || 'Luminio User', avatar || null, now());
  return stmts.getUserById.get(id);
}

function createSession(userId, days) {
  const token = crypto.randomBytes(32).toString('hex');
  const t = now();
  stmts.insertSession.run(token, userId, t, t + (days || 30) * 864e5);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = stmts.getSession.get(token);
  if (!s) return null;
  if (s.expires_at < now()) { stmts.deleteSession.run(token); return null; }
  return s;
}

function createConversation({ userId, title, model }) {
  const id = crypto.randomUUID();
  const t = now();
  stmts.insertConversation.run(id, userId, (title || 'New chat').slice(0, 80), model || 'luminio-3', t, t);
  return stmts.getConversation.get(id);
}

function addMessage({ conversationId, role, content, image }) {
  const id = crypto.randomUUID();
  stmts.insertMessage.run(id, conversationId, role, content, image || null, now());
  return id;
}

function getConfig(key) {
  const row = stmts.getConfig.get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  stmts.setConfig.run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

stmts.deleteExpiredSessions.run(now());

module.exports = {
  db, now, dayStr, upsertUser, getUser: (id) => stmts.getUserById.get(id),
  getUserByEmail: (email) => stmts.getUserByEmail.get(email),
  createSession, getSession, deleteSession: (t) => stmts.deleteSession.run(t),
  listConversations: (uid) => stmts.listConversations.all(uid),
  getConversation: (id) => stmts.getConversation.get(id),
  createConversation, touchConversation: (id, title) => stmts.touchConversation.run(now(), title || null, id),
  setConversationModel: (id, m) => stmts.setConversationModel.run(m, id),
  renameConversation: (id, t) => stmts.renameConversation.run(t.slice(0, 80), id),
  deleteConversation(id) { stmts.deleteMessages.run(id); stmts.deleteConversation.run(id); },
  addMessage, getMessages: (id) => stmts.getMessages.all(id),
  getUsage: (uid, m, d) => stmts.getUsage.get(uid, m, d),
  bumpUsage: (uid, m, d) => stmts.bumpUsage.run(uid, m, d),
  getConfig, setConfig,
  admin: {
    stats() {
      const weekAgo = dayStr(Date.now() - 6 * 864e5);
      return {
        totalUsers: stmts.countUsers.get().n,
        totalConversations: stmts.countConversations.get().n,
        totalMessages: stmts.countMessages.get().n,
        messages24h: stmts.countMessagesSince.get(now() - 864e5).n,
        usageLast7Days: stmts.usageSince.all(weekAgo),
        planDistribution: stmts.planDistribution.all(),
        recentUsers: stmts.recentUsers.all(),
      };
    },
    setUserPlan: (id, plan) => stmts.setUserPlan.run(plan, id),
    setUserBanned: (id, banned) => stmts.setUserBanned.run(banned ? 1 : 0, id),
    resetUsage: (id) => stmts.resetUsage.run(id),
  },
};
