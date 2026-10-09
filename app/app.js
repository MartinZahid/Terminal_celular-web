'use strict';

const API = '/oc';

const $ = (id) => document.getElementById(id);

let started = false;

function handle401(r) {
  if (r && r.status === 401 && started) { location.href = '/auth/login'; return true; }
  return false;
}

const state = {
  sessions: [],
  currentId: null,
  agents: [],
  agent: localStorage.getItem('agent') || 'movil',
  model: null,
  models: [],
  perms: new Map(),
  questions: new Map(),
  busy: false,
};
let es = null;
let busyWatch = null;
let pollTimer = null;

const chatEl = $('chat');
const inputEl = $('input');
const sendBtn = $('btn-send');
const stopBtn = $('btn-stop');
const connEl = $('conn');
const titleEl = $('session-title');
const sessionListEl = $('session-list');
const agentChipsEl = $('agent-chips');
const modelLabelEl = $('model-label');

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function uid() {
  return 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
// esc/fmtTime/md/displayTitle/partKey viven en /app/pure.js (testeable).
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.hidden = true; }, ms);
}

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, window.innerHeight * 0.3) + 'px';
}
function atBottom() {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
}
function scrollBottom(force) {
  if (force || atBottom()) chatEl.scrollTop = chatEl.scrollHeight;
}

const msgEls = new Map();

function ensureMessage(info) {
  if (!info || !info.id) return null;
  let m = msgEls.get(info.id);
  if (m) return m;
  const root = h('div', 'msg ' + (info.role === 'user' ? 'user' : 'assistant'));
  root.dataset.id = info.id;
  if (info.role === 'user') {
    const bubble = h('div', 'bubble');
    root.appendChild(bubble);
    m = { root, bubble, role: 'user' };
  } else {
    const partsWrap = h('div', 'parts');
    const errEl = h('div', 'err');
    errEl.hidden = true;
    root.appendChild(partsWrap);
    root.appendChild(errEl);
    m = { root, partsWrap, errEl, parts: new Map(), role: 'assistant' };
  }
  msgEls.set(info.id, m);
  chatEl.appendChild(root);
  return m;
}

function applyInfo(info) {
  const m = ensureMessage(info);
  if (m && m.role === 'assistant' && info.error) {
    const msg = (info.error.data && info.error.data.message) || info.error.name || 'Error del modelo';
    m.errEl.textContent = msg;
    m.errEl.hidden = false;
  }
  return m;
}



function upsertPart(part) {
  const m = msgEls.get(part.messageID);
  if (!m) return;
  const key = partKey(part);
  if (part.type === 'text') {
    if (m.role === 'user') {
      m.bubble.innerHTML = md(part.text);
      return;
    }
    let tel = m.parts.get(key);
    if (!tel) {
      tel = h('div', 'text');
      m.parts.set(key, tel);
      m.partsWrap.appendChild(tel);
    }
    tel.innerHTML = md(part.text || '');
    return;
  }
  if (m.role !== 'assistant') return;
  let el = m.parts.get(key);
  if (part.type === 'reasoning') {
    if (!el) {
      el = h('details', 'reasoning');
      el.appendChild(h('summary', null, 'razonamiento'));
      el.appendChild(h('pre'));
      m.parts.set(key, el);
      m.partsWrap.appendChild(el);
    }
    el.querySelector('pre').textContent = part.text || '';
    return;
  }
  if (part.type === 'tool') {
    const st = part.state || {};
    const status = st.status || (st.time && st.time.end ? 'completed' : 'running');
    if (!el) {
      el = h('details', 'tool');
      const sum = h('summary');
      sum.appendChild(h('span', 'toolname', part.tool || 'tool'));
      sum.appendChild(h('span', 'muted status'));
      el._sum = sum;
      el.appendChild(sum);
      el.appendChild(h('pre'));
      m.parts.set(key, el);
      m.partsWrap.appendChild(el);
    }
    el.className = 'tool ' + status;
    const label = st.title || status;
    el._sum.querySelector('.toolname').textContent = part.tool || 'tool';
    el._sum.querySelector('.status').textContent = ' · ' + label;
    const body = el.querySelector('pre');
    let txt = '';
    if (st.input) txt += JSON.stringify(st.input, null, 2) + '\n';
    if (st.output) txt += st.output;
    if (st.error) txt += (typeof st.error === 'string' ? st.error : JSON.stringify(st.error, null, 2));
    body.textContent = txt.trim();
    return;
  }
  if (part.type === 'patch') {
    if (!el) { el = h('div', 'patch'); m.parts.set(key, el); m.partsWrap.appendChild(el); }
    el.textContent = 'patch · ' + (part.files || []).join(', ');
    return;
  }
  if (part.type === 'compaction') {
    if (!el) { el = h('div', 'muted'); el.textContent = '… compactando contexto'; m.parts.set(key, el); m.partsWrap.appendChild(el); }
    return;
  }
  if (part.type === 'retry') {
    if (!el) { el = h('div', 'muted'); m.parts.set(key, el); m.partsWrap.appendChild(el); }
    el.textContent = 'reintentando…';
    return;
  }
}

let loadToken = 0;

async function loadMessages(id) {
  const my = ++loadToken;
  const fresh = () => my === loadToken && state.currentId === id;
  let list;
  try {
    const r = await fetch(API + '/session/' + id + '/message?limit=200');
    if (handle401(r)) return;
    if (!r.ok) { if (fresh()) { chatEl.innerHTML = ''; msgEls.clear(); } return; }
    list = await r.json();
  } catch { if (fresh()) { chatEl.innerHTML = ''; msgEls.clear(); } return; }
  if (!fresh()) return;
  chatEl.innerHTML = '';
  msgEls.clear();
  for (const item of list) {
    applyInfo(item.info);
    for (const p of (item.parts || [])) upsertPart(p);
  }
  scrollBottom(true);
}

async function mergeMessages(id) {
  let list;
  try {
    const r = await fetch(API + '/session/' + id + '/message?limit=200');
    if (handle401(r)) return;
    if (!r.ok) return;
    list = await r.json();
  } catch { return; }
  const seen = new Set();
  for (const item of list) {
    if (!item || !item.info) continue;
    applyInfo(item.info);
    seen.add(item.info.id);
    for (const p of (item.parts || [])) upsertPart(p);
  }
  for (const key of [...msgEls.keys()]) {
    if (!seen.has(key)) { const m = msgEls.get(key); if (m) m.root.remove(); msgEls.delete(key); }
  }
  scrollBottom();
}



function renderSessions() {
  sessionListEl.innerHTML = '';
  for (const s of state.sessions) {
    const item = h('div', 'session-item' + (s.id === state.currentId ? ' active' : ''));
    const st = h('div', 'st');
    st.appendChild(h('div', 'stitle', displayTitle(s)));
    st.appendChild(h('div', 'stime', fmtTime(s.time && s.time.updated)));
    item.appendChild(st);
    const del = h('button', 'del', '🗑');
    del.onclick = (e) => { e.stopPropagation(); removeSession(s.id); };
    item.appendChild(del);
    item.onclick = () => { selectSession(s.id); closeDrawer(); };
    sessionListEl.appendChild(item);
  }
}

async function loadSessions() {
  const r = await fetch(API + '/session');
  if (handle401(r)) return;
  if (!r.ok) return;
  state.sessions = await r.json();
  state.sessions.sort((a, b) => ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0));
  renderSessions();
}

async function selectSession(id) {
  state.currentId = id;
  const s = state.sessions.find((x) => x.id === id);
  titleEl.textContent = s ? displayTitle(s) : 'Chat';
  renderSessions();
  await loadMessages(id);
  refreshStatus();
  requestsDismissed = false;
  renderRequests();
}

async function newSession() {
  try {
    const r = await fetch(API + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const s = await r.json();
    state.sessions.unshift(s);
    state.currentId = s.id;
    titleEl.textContent = 'Nuevo chat';
    chatEl.innerHTML = '';
    msgEls.clear();
    renderSessions();
    closeDrawer();
    inputEl.focus();
  } catch { toast('No se pudo crear el chat'); }
}

async function removeSession(id) {
  if (!confirm('¿Borrar este chat?')) return;
  try { await fetch(API + '/session/' + id, { method: 'DELETE' }); } catch { return; }
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.currentId === id) {
    state.currentId = null;
    chatEl.innerHTML = '';
    msgEls.clear();
    titleEl.textContent = 'Sin chat';
  }
  renderSessions();
}

async function renameSession() {
  if (!state.currentId) return;
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (!s) return;
  const t = prompt('Título del chat:', s.title || '');
  if (t == null) return;
  try {
    await fetch(API + '/session/' + state.currentId, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: t }) });
  } catch {}
  s.title = t;
  titleEl.textContent = t;
  renderSessions();
}

function renderAgents() {
  agentChipsEl.innerHTML = '';
  for (const a of state.agents) {
    const b = h('button', 'chip' + (a.name === state.agent ? ' active' : ''), a.name);
    b.onclick = () => { state.agent = a.name; localStorage.setItem('agent', a.name); renderAgents(); };
    agentChipsEl.appendChild(b);
  }
}

async function loadAgents() {
  let all;
  try {
    const r = await fetch(API + '/agent');
    if (!r.ok) return;
    all = await r.json();
  } catch { return; }
  state.agents = all.filter((a) => a.mode === 'primary' || a.mode === 'all');
  if (!state.agents.length) state.agents = all;
  if (!state.agents.find((a) => a.name === state.agent)) {
    const b = state.agents.find((a) => a.name === 'movil') || state.agents.find((a) => a.name === 'build');
    state.agent = (b && b.name) || (state.agents[0] && state.agents[0].name) || 'movil';
  }
  renderAgents();
}

function renderModelLabel() {
  if (!state.model) { modelLabelEl.textContent = 'Modelo'; return; }
  const m = state.models.find((x) => x.providerID === state.model.providerID && x.id === state.model.modelID);
  modelLabelEl.textContent = m ? m.name : state.model.modelID;
}

async function loadModels() {
  let data;
  try {
    const r = await fetch(API + '/config/providers');
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }
  const flat = [];
  for (const p of (data.providers || [])) {
    for (const mid of Object.keys(p.models || {})) {
      const mm = p.models[mid] || {};
      flat.push({ providerID: p.id, providerName: p.name || p.id, id: mid, name: mm.name || mid });
    }
  }
  state.models = flat;
  const saved = localStorage.getItem('model');
  if (saved) { try { state.model = JSON.parse(saved); } catch {} }
  if (!state.model && data.default) {
    const entry = Object.entries(data.default)[0];
    if (entry) state.model = { providerID: entry[0], modelID: entry[1] };
  }
  if (state.model && !flat.find((m) => m.providerID === state.model.providerID && m.id === state.model.modelID)) state.model = null;
  renderModelLabel();
}

function renderModelList(q) {
  const list = $('model-list');
  list.innerHTML = '';
  const query = (q || '').toLowerCase();
  const groups = {};
  for (const m of state.models) {
    if (query && !(m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query) || m.providerName.toLowerCase().includes(query))) continue;
    (groups[m.providerName] = groups[m.providerName] || []).push(m);
  }
  for (const prov of Object.keys(groups)) {
    list.appendChild(h('div', 'model-group', prov));
    for (const m of groups[prov]) {
      const active = state.model && state.model.providerID === m.providerID && state.model.modelID === m.id;
      const it = h('div', 'model-item' + (active ? ' active' : ''), m.name);
      it.onclick = () => {
        state.model = { providerID: m.providerID, modelID: m.id };
        localStorage.setItem('model', JSON.stringify(state.model));
        renderModelLabel();
        $('sheet-model').hidden = true;
      };
      list.appendChild(it);
    }
  }
}

function openModelSheet() {
  $('model-search').value = '';
  renderModelList('');
  $('sheet-model').hidden = false;
  setTimeout(() => $('model-search').focus(), 50);
}

let pollInFlight = false;
let requestsSig = '';
let requestsDismissed = false;

function setBusy(b) {
  const was = state.busy;
  state.busy = b;
  sendBtn.hidden = b;
  stopBtn.hidden = !b;
  if (busyWatch) { clearTimeout(busyWatch); busyWatch = null; }
  if (b) { busyWatch = setTimeout(checkBusy, 15000); schedulePoll(1200); }
  else {
    if (was) loadSessions().catch(() => {});
    schedulePoll(8000);
  }
}

function schedulePoll(ms) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(pollTick, ms);
}

async function pollTick() {
  pollTimer = null;
  if (document.hidden) { schedulePoll(5000); return; }
  if (pollInFlight) { schedulePoll(2000); return; }
  pollInFlight = true;
  try {
    await pollRequests();
    if (state.currentId) {
      await mergeMessages(state.currentId).catch(() => {});
      const box = document.getElementById('inline-reqs');
      if (box && chatEl.lastElementChild !== box) chatEl.appendChild(box);
      await refreshStatus();
    }
  } catch {}
  pollInFlight = false;
  schedulePoll(state.busy ? 3000 : 10000);
}

async function pollOnce() {
  pollRequests();
  if (!state.currentId) return;
  await mergeMessages(state.currentId).catch(() => {});
  try {
    const r = await fetch(API + '/session/status');
    if (r.ok) {
      const s = await r.json();
      const st = s[state.currentId];
      if (!st || st.type === 'idle') setBusy(false);
    }
  } catch {}
}

async function refreshStatus() {
  if (!state.currentId) return;
  try {
    const r = await fetch(API + '/session/status');
    if (r.ok) {
      const s = await r.json();
      const st = s[state.currentId];
      setBusy(!!(st && st.type === 'busy'));
    }
  } catch {}
}

function resync() {
  if (document.hidden || !started) return;
  connectEvents();
  if (state.currentId) mergeMessages(state.currentId).catch(() => {});
  pollOnce();
  pollRequests();
  schedulePoll(1200);
}

async function checkBusy() {
  busyWatch = null;
  if (!state.busy || !state.currentId) return;
  try {
    const r = await fetch(API + '/session/status');
    if (r.ok) {
      const s = await r.json();
      const st = s[state.currentId];
      if (!st || st.type === 'idle') { setBusy(false); return; }
    }
  } catch {}
  if (state.busy) busyWatch = setTimeout(checkBusy, 15000);
}

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (!state.currentId) await newSession();
  if (!state.currentId) return;
  inputEl.value = '';
  autosize();
  const messageID = uid();
  ensureMessage({ id: messageID, sessionID: state.currentId, role: 'user', time: { created: Date.now() } });
  upsertPart({ id: 'p_' + messageID, messageID, sessionID: state.currentId, type: 'text', text });
  scrollBottom(true);
  const body = { parts: [{ type: 'text', text }], agent: state.agent, messageID };
  if (state.model) body.model = { providerID: state.model.providerID, modelID: state.model.modelID };
  setBusy(true);
  try {
    const r = await fetch(API + '/session/' + state.currentId + '/prompt_async', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (handle401(r)) return;
    if (!r.ok && r.status !== 204) { toast('Error ' + r.status); setBusy(false); }
  } catch { toast('Sin conexión'); setBusy(false); }
}

async function abort() {
  if (!state.currentId) return;
  try { await fetch(API + '/session/' + state.currentId + '/abort', { method: 'POST' }); } catch {}
  setBusy(false);
}

function buildRequestCards(container, perms, questions, cur) {
  for (const p of perms) {
    const card = h('div', 'perm');
    card.appendChild(h('div', 'ptitle', p.title || p.permission || p.type || 'Permiso'));
    const meta = p.metadata ? (p.metadata.command || p.metadata.filepath || JSON.stringify(p.metadata)) : ((p.patterns || []).join(', '));
    if (meta) card.appendChild(h('div', 'pmeta', String(meta)));
    const acts = h('div', 'pactions');
    const once = h('button', 'allow', 'Permitir');
    once.onclick = () => replyPerm(p.id, p.sessionID || cur, 'once');
    const always = h('button', 'allow', 'Siempre');
    always.onclick = () => replyPerm(p.id, p.sessionID || cur, 'always');
    const reject = h('button', 'reject', 'Rechazar');
    reject.onclick = () => replyPerm(p.id, p.sessionID || cur, 'reject');
    acts.append(once, always, reject);
    card.appendChild(acts);
    container.appendChild(card);
  }

  for (const req of questions) {
    const card = h('div', 'perm');
    const qs = req.questions || [];
    const selected = qs.map(() => []);
    qs.forEach((q, qi) => {
      if (q.header) card.appendChild(h('div', 'ptitle', q.header));
      card.appendChild(h('div', 'pmeta', q.question || ''));
      const opts = h('div', 'qopts');
      (q.options || []).forEach((opt) => {
        const b = h('button', 'qopt', opt.label);
        if (opt.description) b.title = opt.description;
        b.onclick = () => {
          if (q.multiple) {
            const i = selected[qi].indexOf(opt.label);
            if (i >= 0) selected[qi].splice(i, 1); else selected[qi].push(opt.label);
            b.classList.toggle('active');
          } else {
            selected[qi] = [opt.label];
            [...opts.children].forEach((c) => c.classList.remove('active'));
            b.classList.add('active');
          }
        };
        opts.appendChild(b);
      });
      card.appendChild(opts);
      if (q.custom) {
        const inp = h('input', 'qcustom');
        inp.placeholder = 'Escribe tu respuesta…';
        inp.oninput = () => { selected[qi] = inp.value.trim() ? [inp.value.trim()] : []; };
        card.appendChild(inp);
      }
    });
    const acts = h('div', 'pactions');
    const answer = h('button', 'allow', 'Responder');
    answer.onclick = () => answerQuestion(req.id, req.sessionID || cur, selected);
    const reject = h('button', 'reject', 'Rechazar');
    reject.onclick = () => rejectQuestion(req.id, req.sessionID || cur);
    acts.append(answer, reject);
    card.appendChild(acts);
    container.appendChild(card);
  }
}

function renderRequests() {
  const cur = state.currentId;
  const perms = [...state.perms.values()].filter((p) => !p.sessionID || p.sessionID === cur);
  const questions = [...state.questions.values()].filter((q) => !q.sessionID || q.sessionID === cur);

  const list = $('perm-list');
  list.innerHTML = '';
  buildRequestCards(list, perms, questions, cur);
  const any = perms.length || questions.length;
  if (any && !requestsDismissed) $('sheet-perm').hidden = false;
  if (!any) $('sheet-perm').hidden = true;

  renderInline(perms, questions, cur);
}

function renderInline(perms, questions, cur) {
  const prev = document.getElementById('inline-reqs');
  if (prev) prev.remove();
  if (!cur || (!perms.length && !questions.length)) return;
  const box = h('div', 'inline-reqs');
  box.id = 'inline-reqs';
  box.appendChild(h('div', 'inline-req-title', 'Esperando tu respuesta'));
  buildRequestCards(box, perms, questions, cur);
  chatEl.appendChild(box);
  scrollBottom();
}

async function replyPerm(id, sessionId, reply) {
  const sid = sessionId || state.currentId;
  if (!sid) return;
  let ok = false;
  try {
    const r = await fetch(API + '/session/' + sid + '/permissions/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response: reply }) });
    ok = r.ok;
  } catch {}
  if (!ok) { toast('No se pudo responder el permiso'); return; }
  state.perms.delete(id);
  renderRequests();
}

async function answerQuestion(id, sessionId, answers) {
  const sid = sessionId || state.currentId;
  if (!sid) return;
  let ok = false;
  try {
    const r = await fetch(API + '/question/' + id + '/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers }) });
    ok = r.ok;
  } catch {}
  if (!ok) { toast('No se pudo enviar la respuesta'); return; }
  state.questions.delete(id);
  renderRequests();
}

async function rejectQuestion(id, sessionId) {
  const sid = sessionId || state.currentId;
  if (!sid) return;
  let ok = false;
  try {
    const r = await fetch(API + '/question/' + id + '/reject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    ok = r.ok;
  } catch {}
  if (!ok) { toast('No se pudo rechazar'); return; }
  state.questions.delete(id);
  renderRequests();
}

async function pollRequests() {
  try {
    const [qr, pr] = await Promise.all([
      fetch(API + '/question').then((r) => (handle401(r) ? {} : r.ok ? r.json() : null)).catch(() => null),
      fetch(API + '/permission').then((r) => (handle401(r) ? {} : r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (qr === null && pr === null) return; // fallo de red: conserva las tarjetas
    if (qr !== null) {
      const qs = Array.isArray(qr) ? qr : (qr && qr.data) || [];
      state.questions.clear();
      for (const q of qs) state.questions.set(q.id, q);
    }
    if (pr !== null) {
      const ps = Array.isArray(pr) ? pr : (pr && pr.data) || [];
      state.perms.clear();
      for (const p of ps) state.perms.set(p.id, p);
    }
    const sig = [...state.perms.keys()].map((x) => 'p:' + x).concat([...state.questions.keys()].map((x) => 'q:' + x)).sort().join('|');
    if (sig === requestsSig) return;
    requestsSig = sig;
    requestsDismissed = false;
    renderRequests();
  } catch {}
}

function handleEvent(type, p) {
  switch (type) {
    case 'server.connected':
      connEl.className = 'dot on';
      break;
    case 'message.updated': {
      const info = p.info;
      if (!info || info.sessionID !== state.currentId) break;
      applyInfo(info);
      if (info.role === 'assistant' && info.time && info.time.completed) setBusy(false);
      break;
    }
    case 'message.part.updated': {
      const part = p.part;
      if (!part || part.sessionID !== state.currentId) break;
      if (!msgEls.has(part.messageID)) ensureMessage({ id: part.messageID, sessionID: part.sessionID, role: 'assistant' });
      upsertPart(part);
      scrollBottom();
      break;
    }
    case 'message.removed': {
      if (p.sessionID !== state.currentId) break;
      const m = msgEls.get(p.messageID);
      if (m) { m.root.remove(); msgEls.delete(p.messageID); }
      break;
    }
    case 'permission.updated': {
      if (p.sessionID && p.sessionID !== state.currentId) break;
      state.perms.set(p.id, p);
      renderRequests();
      break;
    }
    case 'permission.replied':
      state.perms.delete(p.permissionID);
      renderRequests();
      break;
    case 'session.created':
    case 'session.updated': {
      const info = p.info;
      if (!info) break;
      const i = state.sessions.findIndex((s) => s.id === info.id);
      if (i >= 0) state.sessions[i] = info; else state.sessions.unshift(info);
      state.sessions.sort((a, b) => ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0));
      if (info.id === state.currentId) titleEl.textContent = displayTitle(info);
      renderSessions();
      break;
    }
    case 'session.deleted':
      if (p.info) { state.sessions = state.sessions.filter((s) => s.id !== p.info.id); renderSessions(); }
      break;
    case 'session.status':
      if (p.sessionID === state.currentId) setBusy(!!(p.status && p.status.type === 'busy'));
      break;
    case 'session.idle':
      if (p.sessionID === state.currentId) setBusy(false);
      break;
  }
}

function connectEvents() {
  if (es) es.close();
  let firstOpen = true;
  es = new EventSource(API + '/event');
  es.onopen = async () => {
    connEl.className = 'dot on';
    if (firstOpen) { firstOpen = false; return; }
    try {
      const me = await (await fetch('/auth/me')).json();
      if (!me.authenticated) { location.href = '/auth/login'; return; }
    } catch { return; }
    await loadSessions().catch(() => {});
    if (state.currentId) await loadMessages(state.currentId).catch(() => {});
  };
  es.onerror = () => { connEl.className = 'dot off'; };
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev.type, ev.properties || {});
  };
}

function openDrawer() { $('drawer').hidden = false; $('scrim').hidden = false; }
function closeDrawer() { $('drawer').hidden = true; $('scrim').hidden = true; }

function showDisabled() {
  const d = h('div');
  d.style.cssText = 'position:fixed;inset:0;z-index:70;display:grid;place-items:center;text-align:center;background:var(--bg);padding:24px';
  d.innerHTML = '<div><h1>Terminal desactivada</h1><p style="color:var(--muted)">Actívala para usar la app.</p><a href="/auth/terminal-on">Activar terminal</a></div>';
  document.body.appendChild(d);
}

function showPin() {
  const screen = $('pin-screen');
  screen.hidden = false;
  $('pin-input').focus();
  $('pin-form').onsubmit = async (e) => {
    e.preventDefault();
    const pin = $('pin-input').value;
    try {
      const r = await fetch('/auth/verify-pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
      if (r.ok) { screen.hidden = true; start(); }
      else { $('pin-error').hidden = false; $('pin-error').textContent = 'PIN incorrecto'; }
    } catch { $('pin-error').hidden = false; $('pin-error').textContent = 'Error de conexión'; }
  };
}

async function start() {
  started = true;
  $('pin-screen').hidden = true;
  connectEvents();
  await Promise.all([loadAgents(), loadModels()]).catch(() => {});
  await loadSessions().catch(() => {});
  if (state.sessions.length) await selectSession(state.sessions[0].id);
  else await newSession();
  schedulePoll(1200);
}

async function boot() {
  let me;
  try {
    me = await (await fetch('/auth/me')).json();
  } catch { toast('No se pudo conectar con el servidor'); return; }
  if (!me.authenticated) { location.href = '/auth/login'; return; }
  if (me.pinConfigured && !me.pinVerified) { showPin(); return; }
  if (me.enabled === false) { showDisabled(); return; }
  start();
}

sendBtn.onclick = send;
stopBtn.onclick = abort;
$('btn-new').onclick = newSession;
$('btn-new2').onclick = newSession;
$('btn-drawer').onclick = openDrawer;
$('scrim').onclick = closeDrawer;
titleEl.onclick = renameSession;
$('btn-model').onclick = openModelSheet;
$('model-search').oninput = (e) => renderModelList(e.target.value);
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { const s = b.closest('.sheet'); s.hidden = true; if (s && s.id === 'sheet-perm') requestsDismissed = true; }; });
$('sheet-model').onclick = (e) => { if (e.target.id === 'sheet-model') $('sheet-model').hidden = true; };
$('sheet-perm').onclick = (e) => { if (e.target.id === 'sheet-perm') { $('sheet-perm').hidden = true; requestsDismissed = true; } };
inputEl.addEventListener('input', autosize);
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia('(pointer:coarse)').matches) { e.preventDefault(); send(); } });

document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
window.addEventListener('pageshow', () => resync());
window.addEventListener('focus', () => resync());
window.addEventListener('online', () => resync());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/app/sw.js', { updateViaCache: 'none' })
    .then((reg) => { reg.update().catch(() => {}); })
    .catch(() => {});
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return;
    reloaded = true;
    location.reload();
  });
}

boot();
