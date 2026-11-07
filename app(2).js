/* ============================================================
   Luminio AI — frontend application
   ============================================================ */
'use strict';

/* ---------- tiny helpers ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeFmt = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateFmt = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3400);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('luminio.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('luminio.' + k, JSON.stringify(v)); } catch (_) {} },
  del(k) { try { localStorage.removeItem('luminio.' + k); } catch (_) {} },
};

/* ---------- global state ---------- */
const state = {
  token: store.get('token', null),
  user: null,
  models: [],
  conversations: [],
  currentId: null,
  model: store.get('model', 'luminio-3'),
  settings: Object.assign({ theme: 'dark', voiceRate: 1, voicePitch: 1, voiceOut: true, enterSend: true }, store.get('settings', {})),
  generating: false,
  abort: null,
  pendingImage: null, // { data, mime, previewUrl }
  adminToken: null,   // in-memory only, never persisted
  recog: null,
  speaking: null,
};

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  let data = null;
  try { data = await r.json(); } catch (_) {}
  if (r.status === 401 && state.token) { logout(false); throw new Error((data && data.error) || 'Session expired. Please sign in again.'); }
  if (!r.ok) { const e = new Error((data && data.error) || ('Request failed (' + r.status + ')')); e.status = r.status; e.data = data; throw e; }
  return data;
}

async function loadConfig() {
  const c = await api('/api/config');
  state.models = c.models;
  if (!state.models.some((m) => m.id === state.model)) state.model = state.models[0]?.id || 'luminio-3';
  return c;
}

async function refreshUsage() {
  try {
    const u = await api('/api/usage');
    const cur = u.models.find((m) => m.id === state.model);
    const pill = $('#usage-pill');
    if (cur) {
      pill.textContent = cur.label + ' · ' + cur.remaining + '/' + cur.limit + ' left';
      pill.classList.toggle('low', cur.remaining <= Math.max(1, cur.limit * 0.15));
    }
    state.usage = u.models;
  } catch (_) {}
}

/* ---------- theme & settings ---------- */
function applyTheme() { document.documentElement.dataset.theme = state.settings.theme; store.set('settings', state.settings); }
applyTheme();

/* ---------- auth ---------- */
function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
}
function showApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderSidebarUser();
  buildModelMenu();
  refreshUsage();
}

async function enterApp(user, token) {
  state.user = user; state.token = token;
  store.set('token', token);
  showApp();
  await loadHistory();
  route();
}

function logout(callApi = true) {
  if (callApi && state.token) api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  speechSynthesis.cancel();
  state.token = null; state.user = null; state.currentId = null; state.conversations = [];
  store.del('token');
  showAuth();
}

async function handleGoogleCredential(credential) {
  try {
    const r = await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ idToken: credential }) });
    toast('Welcome, ' + (r.user.name || 'friend') + '!', 'ok');
    await enterApp(r.user, r.token);
  } catch (e) { toast(e.message, 'error'); }
}

async function initGoogle(config) {
  if (!config.googleClientId) { $('#google-not-configured').classList.remove('hidden'); return; }
  await new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.onload = resolve; s.onerror = resolve;
    document.head.appendChild(s);
  });
  if (!window.google?.accounts?.id) return;
  google.accounts.id.initialize({ client_id: config.googleClientId, callback: (r) => handleGoogleCredential(r.credential) });
  google.accounts.id.renderButton($('#google-btn-wrap'), { theme: state.settings.theme === 'dark' ? 'filled_black' : 'outline', size: 'large', width: 320, text: 'continue_with' });
}

$('#guest-btn').addEventListener('click', async () => {
  let deviceId = store.get('deviceId', null);
  if (!deviceId) { deviceId = crypto.randomUUID(); store.set('deviceId', deviceId); }
  try {
    const r = await api('/api/auth/guest', { method: 'POST', body: JSON.stringify({ deviceId }) });
    toast('Continuing as guest — sign in anytime to keep your chats across devices.', 'ok');
    await enterApp(r.user, r.token);
  } catch (e) { toast(e.message, 'error'); }
});

/* ---------- sidebar ---------- */
function renderSidebarUser() {
  const u = state.user;
  $('#sidebar-user').innerHTML =
    (u.avatar ? '<img src="' + esc(u.avatar) + '" alt=""/>' : '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Ccircle cx=%2232%22 cy=%2232%22 r=%2232%22 fill=%22%237c5cff%22/%3E%3Ctext x=%2232%22 y=%2242%22 font-size=%2230%22 text-anchor=%22middle%22 fill=%22white%22 font-family=%22Arial%22%3E' + esc((u.name || 'L')[0].toUpperCase()) + '%3C/text%3E%3C/svg%3E" alt=""/>') +
    '<div><div class="u-name">' + esc(u.name || 'User') + '</div><div class="u-plan">' + esc(u.plan) + '</div></div>';
}

$('#logout-btn').addEventListener('click', () => { speechSynthesis.cancel(); logout(true); });
$('#new-chat-btn').addEventListener('click', () => { newChat(); });
$('#menu-btn').addEventListener('click', () => { $('#sidebar').classList.remove('collapsed'); $('#sidebar-backdrop').classList.add('show'); });
$('#sidebar-backdrop').addEventListener('click', () => { $('#sidebar').classList.add('collapsed'); $('#sidebar-backdrop').classList.remove('show'); });
$('#collapse-btn').addEventListener('click', () => { $('#sidebar').classList.toggle('collapsed'); });
$('#side-search-input').addEventListener('input', (e) => {
  if (location.hash.replace('#', '').split('?')[0] !== 'history') location.hash = '#/history';
  renderHistoryList(e.target.value);
});

/* ---------- model selector ---------- */
function buildModelMenu() {
  $('#model-selector-label').textContent = (state.models.find((m) => m.id === state.model) || {}).label || 'Luminio';
  const menu = $('#model-menu');
  menu.innerHTML = state.models.map((m) => {
    const u = (state.usage || []).find((x) => x.id === m.id);
    return '<div class="model-option' + (m.id === state.model ? ' selected' : '') + '" data-model="' + m.id + '" role="option" aria-selected="' + (m.id === state.model) + '">' +
      '<div class="mo-name">' + esc(m.label) + (u ? '<span class="mo-left">' + u.remaining + ' left</span>' : '') + '</div>' +
      '<div class="mo-tag">' + esc(m.tagline) + '</div></div>';
  }).join('');
  $$('.model-option', menu).forEach((el) => el.addEventListener('click', () => selectModel(el.dataset.model)));
}
function selectModel(id) {
  state.model = id; store.set('model', id);
  buildModelMenu(); refreshUsage();
  $('#model-menu').classList.add('hidden');
  toast('Switched to ' + ((state.models.find((m) => m.id === id) || {}).label || id));
}
$('#model-selector').addEventListener('click', () => $('#model-menu').classList.toggle('hidden'));
document.addEventListener('click', (e) => {
  if (!$('#model-menu').classList.contains('hidden') && !e.target.closest('.model-selector') && !e.target.closest('.model-menu'))
    $('#model-menu').classList.add('hidden');
});

/* ---------- markdown ---------- */
function md(text) {
  if (!window.marked) return '<p>' + esc(text) + '</p>';
  marked.setOptions({ breaks: true, gfm: true });
  const html = marked.parse(text);
  return window.DOMPurify ? DOMPurify.sanitize(html) : html;
}
function highlightCodes(root) {
  if (window.hljs) $$('pre code', root).forEach((c) => { try { hljs.highlightElement(c); } catch (_) {} });
  $$('pre', root).forEach((pre) => {
    if ($('.code-copy', pre)) return;
    const b = document.createElement('button');
    b.className = 'code-copy'; b.textContent = 'Copy';
    b.addEventListener('click', () => { navigator.clipboard.writeText($('code', pre)?.innerText || pre.innerText).then(() => { b.textContent = 'Copied!'; setTimeout(() => (b.textContent = 'Copy'), 1200); }); });
    pre.appendChild(b);
  });
}

/* ---------- router ---------- */
const routes = { chat: viewChat, history: viewHistory, models: viewModels, subscription: viewSubscription, settings: viewSettings, profile: viewProfile, admin: viewAdmin };
function route() {
  if (!state.token) return;
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0] || '';
  const name = routes[hash] ? hash : 'chat';
  $$('#nav .nav-item').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  $('#sidebar').classList.add('collapsed'); $('#sidebar-backdrop').classList.remove('show');
  routes[name]();
}
window.addEventListener('hashchange', route);

function newChat() {
  state.currentId = null;
  if (location.hash.replace('#', '').split('?')[0] !== 'chat') location.hash = '#/chat';
  else viewChat();
}

/* ---------- chat view ---------- */
const ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
  regen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-2.6-6.4M21 4v5h-5"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 010 7M18.4 5.6a9 9 0 010 12.8"/></svg>',
  stopSpeak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5l-8.5 8.5a5.5 5.5 0 01-7.8-7.8L13 4a3.7 3.7 0 015.2 5.2l-8.2 8.2a1.85 1.85 0 01-2.6-2.6L15.5 7"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
};

function viewChat() {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const v = $('#view');
  v.innerHTML = '<div class="chat-wrap">' +
    '<div class="chat-scroll" id="chat-scroll"><div class="chat-inner" id="chat-inner">' +
    (state.currentId ? '' :
      '<div class="welcome"><div class="welcome-orb"></div>' +
      '<h2>' + greet + ', <em>' + esc((state.user.name || 'there').split(' ')[0]) + '</em></h2>' +
      '<p>Ask anything — from code and calculus to creative writing. Attach an image, use your voice, or switch between the Luminio models above.</p>' +
      '<div class="suggestion-grid">' +
      '<button class="suggestion" data-q="Explain quantum entanglement like I\'m a curious 15-year-old."><b>Learn</b>Explain quantum entanglement simply</button>' +
      '<button class="suggestion" data-q="Write a Python function that merges two sorted lists, with tests."><b>Code</b>Python: merge sorted lists + tests</button>' +
      '<button class="suggestion" data-q="Give me a 7-day workout plan for a beginner."><b>Plan</b>A beginner 7-day workout plan</button>' +
      '<button class="suggestion" data-q="Draft a friendly email asking my manager for a day off next Friday."><b>Write</b>Draft a polite day-off email</button>' +
      '</div></div>') +
    '</div></div>' +
    '<div class="composer-zone"><div class="composer">' +
    '<div id="img-preview-slot"></div>' +
    '<textarea id="chat-input" rows="1" placeholder="Message Luminio…"></textarea>' +
    '<div class="composer-row">' +
    '<button class="icon-btn" id="attach-btn" title="Attach image">' + ICONS.attach + '</button>' +
    '<input type="file" id="file-input" accept="image/*" capture="environment" class="hidden"/>' +
    '<button class="icon-btn" id="mic-btn" title="Voice input">' + ICONS.mic + '</button>' +
    '<span class="composer-hint">Enter to send · Shift+Enter for new line</span>' +
    '<span class="spacer"></span>' +
    '<button class="send-btn" id="send-btn" disabled>' + ICONS.send + '</button>' +
    '</div></div></div></div>';

  const input = $('#chat-input');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 190) + 'px'; $('#send-btn').disabled = !(input.value.trim() || state.pendingImage); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && state.settings.enterSend) { e.preventDefault(); sendMessage(); } });
  $('#send-btn').addEventListener('click', sendMessage);
  $$('.suggestion').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.q; input.dispatchEvent(new Event('input')); input.focus(); }));
  $('#attach-btn').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) attachImage(f); e.target.value = ''; });
  $('#mic-btn').addEventListener('click', toggleMic);

  if (state.currentId) loadConversationIntoChat(state.currentId);
}

function attachImage(file) {
  if (!file.type.startsWith('image/')) return toast('Only image files are supported.', 'error');
  if (file.size > 10 * 1024 * 1024) return toast('Image is too large (max 10 MB).', 'error');
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    state.pendingImage = { data: dataUrl.split(',')[1], mime: file.type, previewUrl: dataUrl };
    $('#img-preview-slot').innerHTML = '<div class="img-preview"><img src="' + dataUrl + '" alt="preview"/><span>' + esc(file.name.slice(0, 24)) + '</span><button id="rm-img">Remove</button></div>';
    $('#rm-img').addEventListener('click', clearPendingImage);
    $('#chat-input').dispatchEvent(new Event('input'));
    toast('Image attached — ask anything about it.');
  };
  reader.readAsDataURL(file);
}
function clearPendingImage() { state.pendingImage = null; $('#img-preview-slot').innerHTML = ''; $('#chat-input').dispatchEvent(new Event('input')); }

function scrollChat() { const s = $('#chat-scroll'); if (s) s.scrollTop = s.scrollHeight; }

function bubbleShell(role, name) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.innerHTML = '<div class="msg-avatar">' + (role === 'ai' ? 'L' : esc(((state.user.name || 'U')[0] || 'U').toUpperCase())) + '</div>' +
    '<div class="msg-body"><div class="msg-meta"><span class="msg-name">' + esc(name) + '</span><span class="msg-time">' + timeFmt(Date.now()) + '</span></div>' +
    '<div class="msg-bubble"></div><div class="msg-actions"></div></div>';
  $('#chat-inner').appendChild(el);
  scrollChat();
  return el;
}

function addMsgActions(el, role, getText, extra) {
  const bar = $('.msg-actions', el);
  bar.innerHTML = '';
  const mk = (icon, title, fn, cls) => {
    const b = document.createElement('button');
    b.className = 'icon-btn' + (cls ? ' ' + cls : ''); b.title = title; b.innerHTML = icon;
    b.addEventListener('click', fn); bar.appendChild(b); return b;
  };
  if (role === 'ai') {
    mk(ICONS.copy, 'Copy', () => navigator.clipboard.writeText(getText()).then(() => toast('Copied to clipboard', 'ok')));
    mk(ICONS.speaker, 'Listen', () => speak(getText(), bar));
    if (extra && extra.regen) mk(ICONS.regen, 'Regenerate', extra.regen);
  } else {
    mk(ICONS.copy, 'Copy', () => navigator.clipboard.writeText(getText()).then(() => toast('Copied to clipboard', 'ok')));
  }
}

function renderMessage(m, { regen } = {}) {
  const el = bubbleShell(m.role === 'assistant' ? 'ai' : 'user', m.role === 'assistant' ? (state.models.find((x) => x.id === (m.model || state.model))?.label || 'Luminio') : (state.user.name || 'You'));
  const bubble = $('.msg-bubble', el);
  if (m.image) bubble.innerHTML += '<img class="chat-img" src="' + m.image + '" alt="attached image" onerror="this.remove()"/>';
  if (m.role === 'assistant') { bubble.innerHTML += md(m.content); highlightCodes(bubble); }
  else bubble.innerHTML += esc(m.content);
  addMsgActions(el, m.role === 'assistant' ? 'ai' : 'user', () => m.content, regen ? { regen } : null);
  return el;
}

async function loadConversationIntoChat(id) {
  try {
    const r = await api('/api/conversations/' + id);
    $('#chat-inner').innerHTML = '';
    state.currentId = id;
    r.messages.forEach((m, i) => renderMessage(m, { regen: i === r.messages.length - 1 && m.role === 'assistant' ? regenerate : null }));
    scrollChat();
  } catch (e) { toast(e.message, 'error'); }
}

/* streaming chat — shared by send & regenerate */
async function streamChat(body, aiEl) {
  const bubble = $('.msg-bubble', aiEl);
  const bar = $('.msg-actions', aiEl);
  const sendBtn = $('#send-btn');
  let stopBtn;
  state.generating = true;
  state.abort = new AbortController();
  if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = ICONS.stop; stopBtn = sendBtn; stopBtn.onclick = () => state.abort.abort(); }
  bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  let full = '';
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: JSON.stringify(body),
      signal: state.abort.signal,
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw Object.assign(new Error(j.error || ('Request failed (' + resp.status + ')')), { status: resp.status });
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let obj; try { obj = JSON.parse(line); } catch (_) { continue; }
        if (obj.error) throw Object.assign(new Error(obj.error), { status: obj.status });
        if (obj.delta) {
          full += obj.delta;
          bubble.innerHTML = md(full); highlightCodes(bubble); scrollChat();
        }
        if (obj.done) {
          state.currentId = obj.conversationId;
          if (obj.remaining !== undefined) refreshUsage();
          loadHistory();
        }
      }
    }
    if (!full) throw new Error('The model returned an empty response. Please try again.');
    addMsgActions(aiEl, 'ai', () => full, { regen: regenerate });
  } catch (e) {
    if (e.name === 'AbortError') { aiEl.remove(); toast('Generation stopped.'); }
    else {
      bubble.innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>' +
        ' <button class="btn btn-ghost" style="padding:4px 12px;font-size:12px;margin-top:6px" id="retry-btn">Retry</button>';
      $('#retry-btn')?.addEventListener('click', () => { aiEl.remove(); sendMessage(); });
      if (e.status === 429) refreshUsage();
    }
  } finally {
    state.generating = false; state.abort = null;
    if (sendBtn) { sendBtn.innerHTML = ICONS.send; sendBtn.onclick = sendMessage; sendBtn.disabled = !($('#chat-input')?.value.trim() || state.pendingImage); }
  }
}

async function sendMessage() {
  if (state.generating) return;
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text && !state.pendingImage) return;
  const img = state.pendingImage;
  $('#chat-inner .welcome')?.remove();
  const userEl = bubbleShell('user', state.user.name || 'You');
  const ub = $('.msg-bubble', userEl);
  if (img) ub.innerHTML = '<img class="chat-img" src="' + img.previewUrl + '" alt="attached image"/>';
  ub.innerHTML += esc(text);
  addMsgActions(userEl, 'user', () => text);
  state.generating = true; // guard against double submit while DOM updates
  input.value = ''; input.style.height = 'auto';
  clearPendingImage();
  const aiEl = bubbleShell('ai', (state.models.find((m) => m.id === state.model) || {}).label || 'Luminio');
  state.generating = false;
  await streamChat({ conversationId: state.currentId, model: state.model, message: text, image: img?.data, imageMime: img?.mime }, aiEl);
}

async function regenerate() {
  if (state.generating || !state.currentId) return;
  const msgs = $$('#chat-inner .msg');
  const lastAi = [...msgs].reverse().find((m) => m.classList.contains('ai'));
  if (lastAi) lastAi.remove();
  const aiEl = bubbleShell('ai', (state.models.find((m) => m.id === state.model) || {}).label || 'Luminio');
  await streamChat({ conversationId: state.currentId, model: state.model, regenerate: true, message: '' }, aiEl).catch(() => {});
  // regenerate goes to its own endpoint:
}

/* ---------- voice input ---------- */
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Speech recognition is not supported in this browser. Try Chrome or Edge.', 'error');
  if (state.recog) { state.recog.stop(); return; }
  const rec = new SR();
  state.recog = rec;
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  $('#mic-btn').style.color = 'var(--danger)';
  toast('Listening… speak now.');
  const input = $('#chat-input');
  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };
  rec.onend = () => { state.recog = null; $('#mic-btn').style.color = ''; };
  rec.onerror = (e) => { state.recog = null; $('#mic-btn').style.color = ''; if (e.error !== 'aborted') toast('Voice input error: ' + e.error, 'error'); };
  rec.start();
}

/* ---------- voice output (TTS) ---------- */
function speak(text, bar) {
  if (!state.settings.voiceOut) return toast('Voice output is disabled in Settings.', 'error');
  if (!window.speechSynthesis) return toast('Text-to-speech is not supported in this browser.', 'error');
  speechSynthesis.cancel();
  const plain = text.replace(/```[\s\S]*?```/g, ' (code block) ').replace(/[#*`>|]/g, '').slice(0, 4000);
  const u = new SpeechSynthesisUtterance(plain);
  u.rate = state.settings.voiceRate; u.pitch = state.settings.voicePitch;
  state.speaking = u;
  if (bar) {
    const stopB = document.createElement('button');
    stopB.className = 'icon-btn spin'; stopB.title = 'Stop speaking'; stopB.innerHTML = ICONS.stopSpeak;
    stopB.addEventListener('click', () => { speechSynthesis.cancel(); state.speaking = null; });
    bar.appendChild(stopB);
    u.onend = u.onerror = () => stopB.remove();
  }
  speechSynthesis.speak(u);
}

/* ---------- conversation history ---------- */
async function loadHistory() {
  try { const r = await api('/api/conversations'); state.conversations = r.conversations; } catch (_) {}
}

function viewHistory() {
  $('#view').innerHTML = '<div class="view-inner"><h2 class="view-title">Chat History</h2>' +
    '<p class="view-sub">' + state.conversations.length + ' conversation' + (state.conversations.length === 1 ? '' : 's') + ' — stored securely on your account, never lost on refresh.</p>' +
    '<div id="hist-list"></div></div>';
  renderHistoryList($('#side-search-input').value || '');
}

function renderHistoryList(filter) {
  const list = $('#hist-list'); if (!list) return;
  const f = (filter || '').toLowerCase();
  const items = state.conversations.filter((c) => !f || c.title.toLowerCase().includes(f) || (c.last_message || '').toLowerCase().includes(f));
  if (!items.length) {
    list.innerHTML = '<div class="empty-state"><div class="e-icon">💬</div><b>No conversations yet</b><p style="margin-top:6px">Start a new chat and it will appear here automatically.</p></div>';
    return;
  }
  list.innerHTML = items.map((c) =>
    '<div class="hist-item" data-id="' + c.id + '">' +
    '<div class="h-main"><div class="h-title">' + esc(c.title) + '</div>' +
    '<div class="h-sub">' + esc((c.last_message || '').slice(0, 90)) + '</div></div>' +
    '<span class="h-time">' + dateFmt(c.updated_at) + '</span>' +
    '<div class="h-actions">' +
    '<button class="icon-btn" data-act="rename" title="Rename"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.8 2.8 0 114 4L7.5 20.5 2 22l1.5-5.5z"/></svg></button>' +
    '<button class="icon-btn" data-act="delete" title="Delete"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>' +
    '</div></div>').join('');
  $$('.hist-item', list).forEach((el) => {
    el.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const id = el.dataset.id;
      if (act === 'rename') {
        const c = state.conversations.find((x) => x.id === id);
        const t = prompt('Rename conversation:', c.title);
        if (t && t.trim()) { try { await api('/api/conversations/' + id, { method: 'PATCH', body: JSON.stringify({ title: t.trim() }) }); c.title = t.trim(); renderHistoryList($('#side-search-input').value || ''); } catch (er) { toast(er.message, 'error'); } }
      } else if (act === 'delete') {
        if (!confirm('Delete this conversation permanently?')) return;
        try { await api('/api/conversations/' + id, { method: 'DELETE' }); state.conversations = state.conversations.filter((x) => x.id !== id); renderHistoryList($('#side-search-input').value || ''); toast('Conversation deleted', 'ok'); } catch (er) { toast(er.message, 'error'); }
      } else { state.currentId = id; location.hash = '#/chat'; loadConversationIntoChat(id); }
    });
  });
}

/* ---------- models view ---------- */
function viewModels() {
  const day = new Date().toISOString().slice(0, 10);
  const u = (state.usage || []);
  $('#view').innerHTML = '<div class="view-inner"><h2 class="view-title">AI Models</h2>' +
    '<p class="view-sub">Three selectable minds. Quotas reset daily (UTC). You are on the <b>' + esc(state.user.plan) + '</b> plan.</p>' +
    '<div class="card-grid">' + state.models.map((m) => {
      const use = u.find((x) => x.id === m.id) || { used: 0, limit: 0, remaining: 0 };
      return '<div class="card model-card">' +
        '<span class="model-badge">' + esc(m.id.replace('luminio-', 'Gen ')) + '</span>' +
        '<h3>' + esc(m.label) + '</h3><p>' + esc(m.tagline) + '</p>' +
        '<div class="model-limits">' +
        '<span>Free plan: <b>' + use.limit + '</b>/day</span>' +
        '<span>Used today: <b>' + use.used + '</b> · Remaining: <b>' + use.remaining + '</b></span></div>' +
        '<button class="btn ' + (state.model === m.id ? 'btn-ghost' : 'btn-primary') + '" data-model="' + m.id + '">' + (state.model === m.id ? 'Current model' : 'Switch to ' + esc(m.label)) + '</button>' +
        '</div>';
    }).join('') + '</div></div>';
  $$('#view [data-model]').forEach((b) => b.addEventListener('click', () => { selectModel(b.dataset.model); viewModels(); }));
}

/* ---------- subscription view ---------- */
async function viewSubscription() {
  const v = $('#view');
  v.innerHTML = '<div class="view-inner"><h2 class="view-title">Subscription</h2><p class="view-sub">Loading…</p></div>';
  let s;
  try { s = await api('/api/subscription'); } catch (e) { v.innerHTML = '<div class="view-inner"><p>' + esc(e.message) + '</p></div>'; return; }
  const status = (location.hash.split('status=')[1] || '').split('&')[0];
  let banner = '';
  if (status === 'success') banner = '<div class="toast ok" style="margin-bottom:16px">Payment completed — Premium activates as soon as the payment provider confirms it.</div>';
  if (status === 'cancelled') banner = '<div class="toast" style="margin-bottom:16px">Checkout cancelled — no charge was made.</div>';
  v.innerHTML = '<div class="view-inner">' + banner +
    '<h2 class="view-title">Subscription</h2>' +
    '<p class="view-sub">Current plan: <b style="color:var(--accent)">' + (s.plan === 'pro' ? 'Premium' : 'Free') + '</b></p>' +
    '<div class="plan-grid">' +
    '<div class="card plan-card"><div class="p-name">Free</div><div class="p-price">$0</div><div class="p-per">forever</div>' +
    '<ul><li>' + s.models.map((m) => m.label + ': ' + m.freeDaily + '/day').join('</li><li>') + '</li></ul>' +
    (s.plan === 'free' ? '<button class="btn btn-ghost" disabled>Current plan</button>' : '') + '</div>' +
    '<div class="card plan-card featured"><div class="p-name">Premium</div><div class="p-price">$9</div><div class="p-per">per month</div>' +
    '<ul><li>' + s.models.map((m) => m.label + ': ' + m.proDaily + '/day').join('</li><li>') + '</li><li>Priority capacity</li></ul>' +
    (s.plan === 'pro' ? '<button class="btn btn-ghost" disabled>Active ✓</button>'
      : '<button class="btn btn-primary" id="upgrade-btn">' + (s.paymentsEnabled ? 'Upgrade to Premium' : 'Upgrade (contact support)') + '</button>') +
    '</div></div>' +
    '<h3 style="margin-bottom:12px">Today\'s usage</h3><div class="card usage-bars">' +
    s.models.map((m) => {
      const lim = s.plan === 'pro' ? m.proDaily : m.freeDaily;
      const pct = Math.min(100, Math.round((m.used / Math.max(1, lim)) * 100));
      return '<div class="ubar"><div class="ub-top"><span>' + esc(m.label) + '</span><span>' + m.used + ' / ' + lim + ' used</span></div>' +
        '<div class="ub-track"><div class="ub-fill' + (pct >= 100 ? ' full' : '') + '" style="width:' + pct + '%"></div></div></div>';
    }).join('') + '</div>' +
    '<p style="margin-top:16px;font-size:12.5px;color:var(--text-3)">Payments are processed by Stripe. Plans only change after a real, confirmed payment — nothing here is simulated.</p>' +
    '</div>';
  $('#upgrade-btn')?.addEventListener('click', async () => {
    const b = $('#upgrade-btn'); b.disabled = true; b.textContent = 'Preparing checkout…';
    try {
      const r = await api('/api/subscription/checkout', { method: 'POST' });
      if (r.url) location.href = r.url;
      else if (r.message) toast(r.message, 'ok');
    } catch (e) { toast(e.message, 'error'); b.disabled = false; b.textContent = 'Upgrade (contact support)'; }
  });
}

/* ---------- settings view ---------- */
function viewSettings() {
  const s = state.settings;
  $('#view').innerHTML = '<div class="view-inner"><h2 class="view-title">Settings</h2><p class="view-sub">Preferences save automatically and persist across devices for your account.</p>' +
    '<div class="card" style="margin-bottom:16px"><h3 style="margin-bottom:6px">Appearance</h3>' +
    '<div class="toggle-row"><div class="t-info"><b>Dark theme</b><p>Easy on the eyes, day or night.</p></div>' +
    '<label class="switch"><input type="checkbox" id="set-theme" ' + (s.theme === 'dark' ? 'checked' : '') + '/><span class="sl"></span></label></div></div>' +
    '<div class="card" style="margin-bottom:16px"><h3 style="margin-bottom:6px">Chat</h3>' +
    '<div class="toggle-row"><div class="t-info"><b>Enter to send</b><p>Press Enter to send, Shift+Enter for a new line.</p></div>' +
    '<label class="switch"><input type="checkbox" id="set-enter" ' + (s.enterSend ? 'checked' : '') + '/><span class="sl"></span></label></div>' +
    '<div class="toggle-row"><div class="t-info"><b>Default model</b><p>Pre-selected when you start a new chat.</p></div>' +
    '<select id="set-model">' + state.models.map((m) => '<option value="' + m.id + '" ' + (state.model === m.id ? 'selected' : '') + '>' + esc(m.label) + '</option>').join('') + '</select></div></div>' +
    '<div class="card" style="margin-bottom:16px"><h3 style="margin-bottom:6px">Voice</h3>' +
    '<div class="toggle-row"><div class="t-info"><b>Spoken replies</b><p>Allow the assistant to read answers aloud.</p></div>' +
    '<label class="switch"><input type="checkbox" id="set-voiceout" ' + (s.voiceOut ? 'checked' : '') + '/><span class="sl"></span></label></div>' +
    '<div class="field" style="margin-top:12px"><label>Speech rate: <span id="rate-v">' + s.voiceRate.toFixed(1) + '</span>x</label>' +
    '<input type="range" id="set-rate" min="0.5" max="2" step="0.1" value="' + s.voiceRate + '"/></div>' +
    '<div class="field"><label>Voice pitch: <span id="pitch-v">' + s.voicePitch.toFixed(1) + '</span></label>' +
    '<input type="range" id="set-pitch" min="0.5" max="2" step="0.1" value="' + s.voicePitch + '"/></div></div>' +
    '<div class="card" style="margin-bottom:16px"><h3 style="margin-bottom:6px">Privacy & data</h3>' +
    '<div class="toggle-row"><div class="t-info"><b>Clear all conversations</b><p>Permanently delete every chat in your history.</p></div>' +
    '<button class="btn btn-danger" id="wipe-btn">Delete all</button></div></div>' +
    '<button class="btn btn-ghost" id="set-logout">Log out</button></div>';

  $('#set-theme').addEventListener('change', (e) => { state.settings.theme = e.target.checked ? 'dark' : 'light'; applyTheme(); });
  $('#set-enter').addEventListener('change', (e) => { state.settings.enterSend = e.target.checked; store.set('settings', state.settings); });
  $('#set-model').addEventListener('change', (e) => selectModel(e.target.value));
  $('#set-voiceout').addEventListener('change', (e) => { state.settings.voiceOut = e.target.checked; store.set('settings', state.settings); });
  $('#set-rate').addEventListener('input', (e) => { state.settings.voiceRate = +e.target.value; $('#rate-v').textContent = state.settings.voiceRate.toFixed(1); store.set('settings', state.settings); });
  $('#set-pitch').addEventListener('input', (e) => { state.settings.voicePitch = +e.target.value; $('#pitch-v').textContent = state.settings.voicePitch.toFixed(1); store.set('settings', state.settings); });
  $('#set-logout').addEventListener('click', () => logout(true));
  $('#wipe-btn').addEventListener('click', async () => {
    if (!confirm('Delete ALL your conversations? This cannot be undone.')) return;
    try { for (const c of [...state.conversations]) await api('/api/conversations/' + c.id, { method: 'DELETE' }); state.conversations = []; state.currentId = null; toast('All conversations deleted', 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  });
}

/* ---------- profile view ---------- */
async function viewProfile() {
  const v = $('#view');
  v.innerHTML = '<div class="view-inner"><h2 class="view-title">Profile</h2><p class="view-sub">Loading…</p></div>';
  let me;
  try { me = (await api('/api/me')).user; state.user = me; renderSidebarUser(); } catch (e) { return; }
  v.innerHTML = '<div class="view-inner"><h2 class="view-title">Profile</h2><p class="view-sub">Your Luminio AI account.</p>' +
    '<div class="card"><div class="profile-head">' +
    (me.avatar ? '<img src="' + esc(me.avatar) + '" alt=""/>' : '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Ccircle cx=%2232%22 cy=%2232%22 r=%2232%22 fill=%22%237c5cff%22/%3E%3Ctext x=%2232%22 y=%2242%22 font-size=%2230%22 text-anchor=%22middle%22 fill=%22white%22 font-family=%22Arial%22%3E' + esc((me.name || 'L')[0].toUpperCase()) + '%3C/text%3E%3C/svg%3E" alt=""/>') +
    '<div><h2>' + esc(me.name || 'User') + ' <span class="plan-pill">' + esc(me.plan) + '</span></h2><p>' + esc(me.email) + '</p>' +
    '<p style="margin-top:4px;font-size:12px">Member since ' + new Date(me.createdAt).toLocaleDateString() + '</p></div></div>' +
    '<div class="field"><label>Display name</label><input id="pf-name" value="' + esc(me.name || '') + '" maxlength="60"/></div>' +
    '<button class="btn btn-primary" id="pf-save">Save changes</button></div></div>';
  $('#pf-save').addEventListener('click', async () => {
    try {
      const r = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ name: $('#pf-name').value }) });
      state.user = r.user; renderSidebarUser(); toast('Profile updated', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ---------- admin panel ---------- */
function adminApi(path, opts = {}) {
  const headers = Object.assign({ 'x-admin-secret': state.adminToken || '' }, opts.headers || {});
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(path, Object.assign({}, opts, { headers })).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('Admin request failed (' + r.status + ')'));
    return d;
  });
}

async function viewAdmin() {
  const v = $('#view');
  if (!state.adminToken) {
    v.innerHTML = '<div class="view-inner" style="max-width:460px"><h2 class="view-title">Admin Panel</h2>' +
      '<p class="view-sub">Restricted area. Enter the admin secret to continue. It is never stored in the browser.</p>' +
      '<div class="card"><div class="field"><label>Admin secret</label><input type="password" id="adm-secret" autocomplete="off"/></div>' +
      '<button class="btn btn-primary btn-block" id="adm-enter">Unlock</button>' +
      '<p style="margin-top:12px;font-size:12px;color:var(--text-3)">The secret lives only in the server\'s environment variables (ADMIN_SECRET). It is never shipped to the client.</p></div></div>';
    $('#adm-enter').addEventListener('click', async () => {
      state.adminToken = $('#adm-secret').value;
      try { await adminApi('/api/admin/status'); toast('Admin access granted', 'ok'); viewAdmin(); }
      catch (e) { state.adminToken = null; toast(e.message, 'error'); }
    });
    $('#adm-secret').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#adm-enter').click(); });
    return;
  }
  v.innerHTML = '<div class="view-inner"><h2 class="view-title">Admin Panel</h2><p class="view-sub">Live platform overview.</p><div id="adm-body"><p>Loading…</p></div></div>';
  try {
    const [st, cfg, status] = await Promise.all([adminApi('/api/admin/stats'), adminApi('/api/admin/config'), adminApi('/api/admin/status')]);
    const usageRows = st.usageLast7Days.map((u) => '<tr><td>' + esc(u.day) + '</td><td>' + esc(u.model) + '</td><td>' + u.total + '</td></tr>').join('');
    $('#adm-body').innerHTML =
      '<div class="stat-grid">' +
      '<div class="card stat-card"><div class="s-num">' + st.totalUsers + '</div><div class="s-label">Registered users</div></div>' +
      '<div class="card stat-card"><div class="s-num">' + st.totalConversations + '</div><div class="s-label">Conversations</div></div>' +
      '<div class="card stat-card"><div class="s-num">' + st.totalMessages + '</div><div class="s-label">Total messages</div></div>' +
      '<div class="card stat-card"><div class="s-num">' + st.messages24h + '</div><div class="s-label">Messages (24h)</div></div>' +
      st.planDistribution.map((p) => '<div class="card stat-card"><div class="s-num">' + p.n + '</div><div class="s-label">' + esc(p.plan) + ' plan users</div></div>').join('') +
      '</div>' +
      '<div class="card" style="margin-bottom:16px"><h3 style="margin-bottom:10px">API status</h3>' +
      '<div class="api-status"><span class="status-dot ' + (status.ping.ok ? 'ok' : 'bad') + '"></span>' +
      '<span>' + (status.geminiConfigured ? (status.ping.ok ? 'Gemini API reachable — provider replied: "' + esc(status.ping.reply) + '"' : 'Gemini key set but request failed: ' + esc(status.ping.error)) : 'GEMINI_API_KEY missing on server') + '</span></div>' +
      '<p style="font-size:12px;color:var(--text-3);margin-top:8px">Uptime: ' + Math.round(status.uptime) + 's</p></div>' +
      '<div class="card" style="margin-bottom:16px"><h3 style="margin-bottom:10px">Daily usage (last 7 days)</h3>' +
      (usageRows ? '<table class="admin-table"><tr><th>Date</th><th>Model</th><th>Messages</th></tr>' + usageRows + '</table>' : '<p style="color:var(--text-3)">No usage recorded yet.</p>') + '</div>' +
      '<div class="card" style="margin-bottom:16px"><h3 style="margin-bottom:10px">Model limits (daily)</h3>' +
      state.models.map((m) => {
        const f = cfg.limits?.free?.[m.id] ?? '', p = cfg.limits?.pro?.[m.id] ?? '';
        return '<div class="field" style="flex-direction:row;align-items:center;gap:10px;justify-content:space-between">' +
          '<b style="min-width:90px">' + esc(m.label) + '</b>' +
          '<span style="font-size:12px;color:var(--text-3)">→ ' + esc(cfg.modelMapping[m.id] || '?') + '</span>' +
          '<span style="display:flex;gap:6px;align-items:center;font-size:12px">Free <input type="number" min="0" style="width:80px" data-lim="free.' + m.id + '" value="' + f + '" placeholder="env"/></span>' +
          '<span style="display:flex;gap:6px;align-items:center;font-size:12px">Pro <input type="number" min="0" style="width:80px" data-lim="pro.' + m.id + '" value="' + p + '" placeholder="env"/></span></div>';
      }).join('') +
      '<div class="field" style="margin-top:6px"><label>Vision model</label><input id="adm-vision" value="' + esc(cfg.visionModel) + '"/></div>' +
      '<button class="btn btn-primary" id="adm-savecfg">Save configuration</button>' +
      '<p style="font-size:11.5px;color:var(--text-3);margin-top:8px">Overrides persist in the database and beat .env values. Leave a field empty to use the .env default.</p></div>' +
      '<div class="card"><h3 style="margin-bottom:10px">User management</h3><div style="overflow-x:auto"><table class="admin-table"><tr><th>Name</th><th>Email</th><th>Plan</th><th>Joined</th><th>Actions</th></tr>' +
      st.recentUsers.map((u) => '<tr><td>' + esc(u.name || '—') + '</td><td>' + esc(u.email) + '</td>' +
        '<td><select data-user="' + u.id + '" class="adm-plan"><option value="free" ' + (u.plan === 'free' ? 'selected' : '') + '>free</option><option value="pro" ' + (u.plan === 'pro' ? 'selected' : '') + '>pro</option></select></td>' +
        '<td>' + new Date(u.created_at).toLocaleDateString() + '</td>' +
        '<td style="white-space:nowrap"><button class="btn btn-ghost" data-reset="' + u.id + '" style="padding:4px 10px;font-size:12px">Reset usage</button> ' +
        '<button class="btn btn-danger" data-ban="' + u.id + '" style="padding:4px 10px;font-size:12px">' + (u.banned ? 'Unban' : 'Ban') + '</button></td></tr>').join('') +
      '</table></div></div>';
    $('#adm-savecfg').addEventListener('click', async () => {
      const limits = { free: {}, pro: {} };
      $$('#adm-body [data-lim]').forEach((i) => { if (i.value !== '') { const [pl, mid] = i.dataset.lim.split('.'); limits[pl][mid] = +i.value; } });
      try { await adminApi('/api/admin/config', { method: 'PUT', body: JSON.stringify({ limits, visionModel: $('#adm-vision').value.trim() }) }); toast('Configuration saved', 'ok'); loadConfig(); }
      catch (e) { toast(e.message, 'error'); }
    });
    $$('.adm-plan').forEach((s) => s.addEventListener('change', async () => {
      try { await adminApi('/api/admin/users/' + s.dataset.user, { method: 'PATCH', body: JSON.stringify({ plan: s.value }) }); toast('Plan updated', 'ok'); } catch (e) { toast(e.message, 'error'); }
    }));
    $$('#adm-body [data-reset]').forEach((b) => b.addEventListener('click', async () => {
      try { await adminApi('/api/admin/users/' + b.dataset.reset + '/reset-usage', { method: 'POST' }); toast('Usage reset', 'ok'); } catch (e) { toast(e.message, 'error'); }
    }));
    $$('#adm-body [data-ban]').forEach((b) => b.addEventListener('click', async () => {
      try { await adminApi('/api/admin/users/' + b.dataset.ban, { method: 'PATCH', body: JSON.stringify({ banned: b.textContent === 'Ban' }) }); viewAdmin(); } catch (e) { toast(e.message, 'error'); }
    }));
  } catch (e) {
    if (/Invalid admin secret/i.test(e.message)) { state.adminToken = null; toast('Session expired — re-enter the admin secret.', 'error'); viewAdmin(); }
    else $('#adm-body').innerHTML = '<p style="color:var(--danger)">' + esc(e.message) + '</p>';
  }
}

/* ---------- corrected regenerate: uses the dedicated endpoint ---------- */
async function regenerate() {
  if (state.generating || !state.currentId) return;
  const msgs = $$('#chat-inner .msg');
  const lastAi = [...msgs].reverse().find((m) => m.classList.contains('ai'));
  if (lastAi) lastAi.remove();
  const aiEl = bubbleShell('ai', (state.models.find((m) => m.id === state.model) || {}).label || 'Luminio');
  const label = $('.msg-name', aiEl).textContent;
  const bubble = $('.msg-bubble', aiEl);
  const sendBtn = $('#send-btn');
  state.generating = true;
  state.abort = new AbortController();
  if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = ICONS.stop; sendBtn.onclick = () => state.abort.abort(); }
  bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  let full = '';
  try {
    const resp = await fetch('/api/chat/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ conversationId: state.currentId, model: state.model }),
      signal: state.abort.signal,
    });
    if (!resp.ok) { const j = await resp.json().catch(() => ({})); throw new Error(j.error || 'Regenerate failed'); }
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let obj; try { obj = JSON.parse(line); } catch (_) { continue; }
        if (obj.error) throw new Error(obj.error);
        if (obj.delta) { full += obj.delta; bubble.innerHTML = md(full); highlightCodes(bubble); scrollChat(); }
        if (obj.done) refreshUsage();
      }
    }
    addMsgActions(aiEl, 'ai', () => full, { regen: regenerate });
  } catch (e) {
    if (e.name === 'AbortError') aiEl.remove();
    else { bubble.innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>'; addMsgActions(aiEl, 'ai', () => ''); }
  } finally {
    state.generating = false; state.abort = null;
    if (sendBtn) { sendBtn.innerHTML = ICONS.send; sendBtn.onclick = sendMessage; sendBtn.disabled = false; }
  }
}

/* ---------- boot ---------- */
(async function init() {
  applyTheme();
  let config = { googleClientId: '' };
  try { config = await loadConfig(); } catch (_) {}
  initGoogle(config);
  if (!state.token) { showAuth(); return; }
  try {
    const r = await api('/api/me');
    state.user = r.user;
    await loadHistory();
    showApp();
    route();
  } catch (_) { logout(false); }
})();
