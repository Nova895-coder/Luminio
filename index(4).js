// Luminio AI - backend server
// Responsibilities: auth (Google Sign-In + guest), chat proxy to Gemini with
// per-plan daily quotas, persistent conversations, Stripe checkout, admin API
// gated by a server-side-only secret. No secrets are ever sent to the client.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');
const gemini = require('./gemini');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const oAuth2Client = new OAuth2Client(CLIENT_ID);

app.use(cors());
// Stripe webhook needs the raw body; everything else uses JSON.
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '20mb' }));

// ---------- tiny in-memory rate limiter ----------
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t - b.start > windowMs) { b = { start: t, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n <= limit;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.start > 15 * 60e3) buckets.delete(k); }, 60e3).unref();

// ---------- auth middleware ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const s = db.getSession(token);
  if (!s) return res.status(401).json({ error: 'Please sign in to continue.' });
  const user = db.getUser(s.user_id);
  if (!user) return res.status(401).json({ error: 'Account not found. Please sign in again.' });
  if (user.banned) return res.status(403).json({ error: 'This account has been suspended.' });
  req.user = user;
  req.sessionToken = token;
  next();
}

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET) return res.status(503).json({ error: 'Admin access is not configured on this server.' });
  const a = Buffer.from(String(secret || ''));
  const b = Buffer.from(process.env.ADMIN_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Invalid admin secret.' });
  }
  next();
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, avatar: u.avatar, plan: u.plan, createdAt: u.created_at,
    preferences: safeJson(u.preferences, {}) };
}
function safeJson(s, d) { try { return JSON.parse(s); } catch (_) { return d; } }

// ---------- public config ----------
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: CLIENT_ID,
    paymentsEnabled: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
    models: gemini.modelConfig().map(({ id, label, tagline }) => ({ id, label, tagline })),
  });
});

// ---------- authentication ----------
app.post('/api/auth/google', async (req, res) => {
  if (!rateLimit('auth:' + req.ip, 20, 60e3)) return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'Missing Google ID token.' });
  if (!CLIENT_ID) return res.status(500).json({ error: 'Google sign-in is not configured on this server.' });
  let payload;
  try {
    const ticket = await oAuth2Client.verifyIdToken({ idToken, audience: CLIENT_ID });
    payload = ticket.getPayload();
  } catch (e) {
    return res.status(401).json({ error: 'Google sign-in verification failed. Please try again.' });
  }
  if (!payload.email) return res.status(401).json({ error: 'Your Google account did not provide an email address.' });
  const user = db.upsertUser({ sub: 'g-' + payload.sub, email: payload.email.toLowerCase(),
    name: payload.name, avatar: payload.picture });
  if (user.banned) return res.status(403).json({ error: 'This account has been suspended.' });
  const token = db.createSession(user.id, SESSION_DAYS);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/guest', (req, res) => {
  const deviceId = String((req.body || {}).deviceId || '').slice(0, 64);
  if (!deviceId) return res.status(400).json({ error: 'Missing device id.' });
  const email = 'guest-' + deviceId.toLowerCase() + '@guest.luminio.local';
  let user = db.getUserByEmail(email);
  if (!user) user = db.upsertUser({ sub: 'guest-' + deviceId, email, name: 'Guest' });
  if (user.banned) return res.status(403).json({ error: 'This account has been suspended.' });
  const token = db.createSession(user.id, SESSION_DAYS);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/logout', auth, (req, res) => { db.deleteSession(req.sessionToken); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.patch('/api/me', auth, (req, res) => {
  const { name, preferences } = req.body || {};
  if (typeof name === 'string' && name.trim()) {
    const { db: raw } = db; raw.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim().slice(0, 60), req.user.id);
  }
  if (preferences && typeof preferences === 'object') {
    const { db: raw } = db; raw.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(preferences).slice(0, 4000), req.user.id);
  }
  res.json({ user: publicUser(db.getUser(req.user.id)) });
});

// ---------- models & usage ----------
app.get('/api/models', (req, res) => res.json({ models: gemini.modelConfig() }));

app.get('/api/usage', auth, (req, res) => {
  const day = db.dayStr();
  const models = gemini.modelConfig().map((m) => {
    const limit = req.user.plan === 'pro' ? m.proDaily : m.freeDaily;
    const used = db.getUsage(req.user.id, m.id, day)?.count || 0;
    return { id: m.id, label: m.label, plan: req.user.plan, used, limit, remaining: Math.max(0, limit - used) };
  });
  res.json({ models, day });
});

// ---------- conversations ----------
app.get('/api/conversations', auth, (req, res) => res.json({ conversations: db.listConversations(req.user.id) }));

app.get('/api/conversations/:id', auth, (req, res) => {
  const c = db.getConversation(req.params.id);
  if (!c || c.user_id !== req.user.id) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({ conversation: c, messages: db.getMessages(c.id) });
});

app.patch('/api/conversations/:id', auth, (req, res) => {
  const c = db.getConversation(req.params.id);
  if (!c || c.user_id !== req.user.id) return res.status(404).json({ error: 'Conversation not found.' });
  const title = String((req.body || {}).title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  db.renameConversation(c.id, title);
  res.json({ conversation: db.getConversation(c.id) });
});

app.delete('/api/conversations/:id', auth, (req, res) => {
  const c = db.getConversation(req.params.id);
  if (!c || c.user_id !== req.user.id) return res.status(404).json({ error: 'Conversation not found.' });
  db.deleteConversation(c.id);
  res.json({ ok: true });
});

// ---------- chat (streaming NDJSON) ----------
function writeNdjson(res, obj) { res.write(JSON.stringify(obj) + '\n'); }

function quotaCheck(user, modelId) {
  const conf = gemini.modelConfig().find((m) => m.id === modelId);
  if (!conf) return { error: 'Unknown model.', status: 400 };
  const day = db.dayStr();
  const limit = user.plan === 'pro' ? conf.proDaily : conf.freeDaily;
  const used = db.getUsage(user.id, modelId, day)?.count || 0;
  if (used >= limit) {
    return { error: `Daily limit reached for ${conf.label} on the ${user.plan === 'pro' ? 'Premium' : 'Free'} plan. It resets at midnight UTC.`, status: 429, remaining: 0, limit };
  }
  return { conf, day, limit, used, remaining: limit - used - 1 };
}

async function streamChat(res, user, { conversationId, model, message, image, imageMime }) {
  const q = quotaCheck(user, model);
  if (q.error) { res.status(q.status).json({ error: q.error, remaining: q.remaining, limit: q.limit }); return; }

  let convo = conversationId ? db.getConversation(conversationId) : null;
  if (convo && convo.user_id !== user.id) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (!convo) {
    convo = db.createConversation({ userId: user.id, title: message.replace(/\s+/g, ' ').slice(0, 60) || 'Image chat', model });
  }
  db.setConversationModel(convo.id, model);
  const imageRef = image ? 'data:' + (imageMime || 'image/png') + ';base64,' + image : null;
  db.addMessage({ conversationId: convo.id, role: 'user', content: message, image: imageRef });
  const history = db.getMessages(convo.id).slice(0, -1); // everything before this user message

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let full = '';
  let failed = null;
  try {
    const stream = gemini.generateStream({ modelId: model, history, message, image, imageMime });
    for await (const delta of stream) {
      full += delta;
      if (!writeNdjson(res, { delta })) { /* client disconnected; keep draining cheaply */ }
    }
  } catch (e) {
    failed = e;
  }

  const closed = res.writableEnded || res.destroyed;
  if (!closed && failed) {
    // User message stays saved so the user can retry; assistant text is discarded.
    writeNdjson(res, { error: failed.message || 'Generation failed.', status: failed.status || 502 });
    res.end();
    return;
  }
  if (closed) return; // client aborted (Stop pressed) — discard partial assistant message

  db.addMessage({ conversationId: convo.id, role: 'assistant', content: full });
  db.touchConversation(convo.id);
  db.bumpUsage(user.id, model, q.day);
  writeNdjson(res, { done: true, conversationId: convo.id, title: convo.title, remaining: q.remaining, limit: q.limit });
  res.end();
}

app.post('/api/chat', auth, async (req, res) => {
  if (!rateLimit('chat:' + req.user.id, 60, 60e3)) return res.status(429).json({ error: 'You are sending messages too quickly. Please slow down.' });
  const { conversationId, model, message, image, imageMime } = req.body || {};
  const clean = String(message || '').trim();
  if (!clean && !image) return res.status(400).json({ error: 'Message is required.' });
  if (clean.length > 16000) return res.status(400).json({ error: 'Message is too long (max 16,000 characters).' });
  if (image && image.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Image is too large (max 10 MB).' });
  await streamChat(res, req.user, { conversationId, model: model || 'luminio-3', message: clean, image, imageMime });
});

app.post('/api/chat/regenerate', auth, async (req, res) => {
  const { conversationId, model } = req.body || {};
  const convo = db.getConversation(conversationId);
  if (!convo || convo.user_id !== req.user.id) return res.status(404).json({ error: 'Conversation not found.' });
  const msgs = db.getMessages(convo.id);
  const lastAssistantIdx = msgs.map((m) => m.role).lastIndexOf('assistant');
  if (lastAssistantIdx === -1) return res.status(400).json({ error: 'Nothing to regenerate.' });
  const keep = msgs.slice(0, lastAssistantIdx);
  // drop trailing assistant messages
  const { db: raw } = db;
  const t = keep.length ? keep[keep.length - 1].created_at : 0;
  raw.prepare('DELETE FROM messages WHERE conversation_id = ? AND created_at > ?').run(convo.id, t);
  const lastUser = [...keep].reverse().find((m) => m.role === 'user');
  if (!lastUser) return res.status(400).json({ error: 'Nothing to regenerate.' });
  await streamChat(res, req.user, { conversationId: convo.id, model: model || convo.model, message: lastUser.content });
});

// ---------- subscription ----------
app.get('/api/subscription', auth, (req, res) => {
  const day = db.dayStr();
  const models = gemini.modelConfig().map((m) => ({
    id: m.id, label: m.label,
    freeDaily: m.freeDaily, proDaily: m.proDaily,
    used: db.getUsage(req.user.id, m.id, day)?.count || 0,
  }));
  res.json({ plan: req.user.plan, models, paymentsEnabled: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID) });
});

// Creates a real Stripe Checkout session. If Stripe is not configured the
// endpoint fails honestly instead of faking a payment success.
app.post('/api/subscription/checkout', auth, async (req, res) => {
  if (req.user.plan === 'pro') return res.json({ url: null, message: 'You already have Premium.' });
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    return res.status(501).json({ error: 'Online payments are not configured yet. Please contact support to upgrade.' });
  }
  try {
    const body = new URLSearchParams({
      mode: 'subscription',
      success_url: (process.env.PUBLIC_URL || 'http://localhost:' + PORT) + '/#subscription?status=success',
      cancel_url: (process.env.PUBLIC_URL || 'http://localhost:' + PORT) + '/#subscription?status=cancelled',
      'client_reference_id': req.user.id,
      'line_items[0][price]': process.env.STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
    });
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const session = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Could not start checkout: ' + (session.error?.message || 'Stripe error') });
    res.json({ url: session.url });
  } catch (e) { res.status(502).json({ error: 'Could not reach the payment provider.' }); }
});

// Stripe webhook -> the ONLY place a plan is upgraded (no fake success states).
app.post('/api/stripe/webhook', async (req, res) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(501).send('not configured');
  const sig = req.headers['stripe-signature'];
  // Minimal signature verification (HMAC of timestamp.payload)
  try {
    const parts = Object.fromEntries(String(sig).split(',').map((p) => p.split('=')));
    const payload = req.body.toString('utf8');
    const expected = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
      .update(parts.t + '.' + payload).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(parts.v1 || '');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad signature');
    const event = JSON.parse(payload);
    if (event.type === 'checkout.session.completed') {
      const userId = event.data.object.client_reference_id;
      if (userId) db.admin.setUserPlan(userId, 'pro');
    }
    res.json({ received: true });
  } catch (e) { res.status(400).send('invalid signature'); }
});

// ---------- admin (secret-gated) ----------
app.get('/api/admin/status', requireAdmin, async (req, res) => {
  res.json({ geminiConfigured: Boolean(process.env.GEMINI_API_KEY), ping: await gemini.ping(), uptime: process.uptime() });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => res.json(db.admin.stats()));

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = db.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const { plan, banned } = req.body || {};
  if (plan === 'free' || plan === 'pro') db.admin.setUserPlan(u.id, plan);
  if (typeof banned === 'boolean') db.admin.setUserBanned(u.id, banned);
  res.json({ user: publicUser(db.getUser(u.id)) });
});

app.post('/api/admin/users/:id/reset-usage', requireAdmin, (req, res) => { db.admin.resetUsage(req.params.id); res.json({ ok: true }); });

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({
    limits: safeJson(db.getConfig('limits') || '{}', {}),
    visionModel: gemini.visionModel(),
    modelMapping: Object.fromEntries(gemini.modelConfig().map((m) => [m.id, m.model])),
  });
});

app.put('/api/admin/config', requireAdmin, (req, res) => {
  const { limits, visionModel: vm } = req.body || {};
  if (limits && limits.free && limits.pro) {
    const clean = { free: {}, pro: {} };
    for (const m of gemini.modelConfig()) {
      clean.free[m.id] = Math.max(0, Math.min(100000, Number(limits.free[m.id] ?? m.freeDaily)));
      clean.pro[m.id] = Math.max(0, Math.min(100000, Number(limits.pro[m.id] ?? m.proDaily)));
    }
    db.setConfig('limits', clean);
  }
  if (typeof vm === 'string' && /^[a-z0-9.\-]+$/i.test(vm)) db.setConfig('visionModel', vm.slice(0, 80));
  res.json({ ok: true });
});

// ---------- static client ----------
const clientDir = path.join(__dirname, '..', 'client');
app.use(express.static(clientDir, { maxAge: '1h' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(clientDir, 'index.html')));

// ---------- boot ----------
if (!process.env.GEMINI_API_KEY) console.warn('[luminio] WARNING: GEMINI_API_KEY is not set — chat will fail until it is configured.');
if (!process.env.ADMIN_SECRET) console.warn('[luminio] WARNING: ADMIN_SECRET is not set — admin panel is disabled.');
app.listen(PORT, () => console.log(`[luminio] Luminio AI server running on http://localhost:${PORT}`));
