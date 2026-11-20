// Eco — servidor real (somente módulos nativos do Node, sem npm install).
// Contas por ID, contatos, mensagens diretas, Ecos (grupos), e sinalização de chamadas de voz/vídeo.
// Uso: node server.js   →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');
const db = { users: {}, tokens: {}, spaces: {}, msgs: {} };
try { Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) {}

let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => fs.writeFile(DATA, JSON.stringify(db), () => {}), 300);
}

const rnd = (n = 8) => crypto.randomBytes(n).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
class AppErr extends Error {}
const fail = m => { throw new AppErr(m); };
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

const streams = new Map();   // userId -> Set<res>
const calls = new Map();     // callId -> { a, b, video, status, timer }
const busy = new Map();      // userId -> callId

function newId() {
  for (let i = 0; i < 200; i++) {
    const id = 'ECO#' + (1000 + crypto.randomInt(9000));
    if (!db.users[id]) return id;
  }
  for (;;) { const id = 'ECO#' + (10000 + crypto.randomInt(990000)); if (!db.users[id]) return id; }
}
const usernameTaken = u => Object.values(db.users).some(x => x.username === u);
const pubLite = u => ({ id: u.id, name: u.name, username: u.username, bio: u.bio || '', avatar: u.avatar || null });
const meOf = u => ({ ...pubLite(u), ringtone: u.ringtone || null });
const contactsOf = u => u.contacts.map(id => db.users[id]).filter(Boolean).map(pubLite);
const spacesOf = uid => Object.values(db.spaces).filter(s => s.members.includes(uid)).map(s => ({
  ...s, members: s.members.map(id => db.users[id]).filter(Boolean).map(pubLite)
}));
const dmKey = (a, b) => 'dm:' + [a, b].sort().join('|');
const onlineIds = () => [...streams.keys()].filter(id => streams.get(id).size > 0);

function emit(uid, evt) {
  const set = streams.get(uid);
  if (!set) return;
  const s = `data: ${JSON.stringify(evt)}\n\n`;
  set.forEach(res => res.write(s));
}
function emitAll(evt) { onlineIds().forEach(id => emit(id, evt)); }
function pushSpaces(s) {
  s.members.forEach(id => { if (db.users[id]) emit(id, { t: 'spaces', spaces: spacesOf(id) }); });
}
function pushMsg(key, msg) {
  const list = db.msgs[key] || (db.msgs[key] = []);
  list.push(msg);
  if (list.length > 1000) list.splice(0, list.length - 1000);
  save();
}
function buildMsg(from, m) {
  if (!m || typeof m !== 'object') fail('Mensagem inválida');
  if (!['text', 'image', 'gif', 'audio'].includes(m.type)) fail('Tipo de mensagem inválido');
  const msg = { id: rnd(), from, ts: Date.now(), type: m.type, text: clean(m.text, 4000), media: null, duration: Number(m.duration) || 0 };
  if (m.type === 'text') { if (!msg.text) fail('Mensagem vazia'); return msg; }
  if (typeof m.media !== 'string' || !/^data:(image|audio)\//.test(m.media)) fail('Mídia inválida');
  if (m.media.length > 12e6) fail('Arquivo grande demais (máximo ~9 MB)');
  msg.media = m.media;
  return msg;
}
function endCall(callId, reason) {
  const c = calls.get(callId);
  if (!c) return;
  clearTimeout(c.timer);
  calls.delete(callId);
  busy.delete(c.a); busy.delete(c.b);
  emit(c.a, { t: 'callEnd', callId, reason });
  emit(c.b, { t: 'callEnd', callId, reason });
}
function tokenUser(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const uid = db.tokens[tok];
  return uid && db.users[uid] ? { uid, tok } : null;
}
function issue(u) {
  const token = rnd(24);
  db.tokens[token] = u.id;
  save();
  return { token, me: meOf(u), contacts: contactsOf(u), spaces: spacesOf(u.id) };
}

function act(action, b, uid) {
  const me = uid ? db.users[uid] : null;
  const need = () => { if (!me) fail('Faça login'); return me; };
  switch (action) {
    case 'register': {
      const name = clean(b.name, 40);
      if (!name) fail('Digite seu nome');
      let uname = clean(b.username || name, 60).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 24) || 'usuario';
      while (usernameTaken(uname)) uname = uname.slice(0, 20) + crypto.randomInt(1000, 9999);
      const id = newId();
      const recovery = rnd(6).toUpperCase();
      const u = { id, name, username: uname, bio: '', avatar: null, ringtone: null, contacts: [], keyHash: sha(recovery), created: Date.now() };
      db.users[id] = u;
      save();
      return { ...issue(u), recovery };
    }
    case 'login': {
      const digits = String(b.id || '').replace(/\D/g, '');
      const u = db.users['ECO#' + digits];
      if (!u || u.keyHash !== sha(clean(b.recovery, 20).toUpperCase())) fail('ID ou chave de recuperação inválidos');
      return issue(u);
    }
    case 'logout': {
      if (b.token) delete db.tokens[b.token];
      save();
      return {};
    }
    case 'me': need(); return { me: meOf(me), contacts: contactsOf(me), spaces: spacesOf(me.id) };
    case 'profile': {
      need();
      if (b.name !== undefined) { const n = clean(b.name, 40); if (!n) fail('Nome vazio'); me.name = n; }
      if (b.username !== undefined) {
        const u = String(b.username).toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 24);
        if (!u) fail('@usuário inválido');
        if (Object.values(db.users).some(x => x.username === u && x.id !== me.id)) fail('Este @usuário já existe');
        me.username = u;
      }
      if (b.bio !== undefined) me.bio = clean(b.bio, 240);
      if (b.avatar !== undefined) {
        if (b.avatar === null) me.avatar = null;
        else if (/^data:image\//.test(b.avatar) && b.avatar.length < 3e6) me.avatar = b.avatar;
        else fail('Avatar inválido ou grande demais');
      }
      if (b.ringtone !== undefined) {
        if (b.ringtone === null) me.ringtone = null;
        else if (/^data:audio\//.test(b.ringtone) && b.ringtone.length < 1.5e6) me.ringtone = b.ringtone;
        else fail('Toque inválido ou longo demais (máximo 5 segundos)');
      }
      save();
      emitAll({ t: 'userUpdate', user: pubLite(me) });
      return { me: meOf(me) };
    }
    case 'find': {
      const q = clean(b.q, 60).toLowerCase().replace(/^@/, '');
      const digits = q.replace(/\D/g, '');
      let u = null;
      if (/^(eco)?#?\d{4,}$/.test(q) && db.users['ECO#' + digits]) u = db.users['ECO#' + digits];
      if (!u) u = Object.values(db.users).find(x => x.username === q);
      return { user: u && u.id !== uid ? pubLite(u) : null, self: !!(u && u.id === uid) };
    }
    case 'addContact': {
      need();
      const other = db.users[String(b.id || '')];
      if (!other || other.id === me.id) fail('Usuário não encontrado');
      if (!me.contacts.includes(other.id)) me.contacts.push(other.id);
      if (!other.contacts.includes(me.id)) other.contacts.push(me.id);
      save();
      emit(other.id, { t: 'contacts', contacts: contactsOf(other) });
      return { contacts: contactsOf(me) };
    }
    case 'dmHistory': {
      need();
      if (!me.contacts.includes(b.with)) fail('Adicione este contato para ver a conversa');
      return { msgs: db.msgs[dmKey(me.id, b.with)] || [] };
    }
    case 'dmSend': {
      need();
      if (!me.contacts.includes(b.to)) fail('Adicione este contato antes de enviar mensagens');
      const msg = buildMsg(me.id, b.msg);
      pushMsg(dmKey(me.id, b.to), msg);
      emit(me.id, { t: 'dmMsg', key: 'dm:' + b.to, msg });
      emit(b.to, { t: 'dmMsg', key: 'dm:' + me.id, msg });
      return { msg };
    }
    case 'typing': {
      need();
      if (me.contacts.includes(b.to)) emit(b.to, { t: 'typing', from: me.id });
      return {};
    }
    case 'createSpace': {
      need();
      const name = clean(b.name, 40);
      if (!name) fail('Dê um nome ao Eco');
      const id = 's' + rnd(6);
      const code = 'ECO-' + rnd(2).toUpperCase() + '-' + rnd(2).toUpperCase();
      db.spaces[id] = { id, name, desc: clean(b.desc, 120), code, members: [me.id],
        channels: [{ id: 'geral', name: 'geral', kind: 'text' }, { id: 'midia', name: 'mídia', kind: 'text' }] };
      save();
      pushSpaces(db.spaces[id]);
      return { spaceId: id };
    }
    case 'joinSpace': {
      need();
      const code = clean(b.code, 30).toUpperCase();
      const s = Object.values(db.spaces).find(x => x.code === code);
      if (!s) fail('Código inválido');
      if (!s.members.includes(me.id)) s.members.push(me.id);
      save();
      pushSpaces(s);
      return { spaceId: s.id };
    }
    case 'leaveSpace': {
      need();
      const s = db.spaces[b.id];
      if (!s || !s.members.includes(me.id)) fail('Você não está neste Eco');
      s.members = s.members.filter(x => x !== me.id);
      if (s.members.length === 0) delete db.spaces[s.id]; else pushSpaces(s);
      save();
      emit(me.id, { t: 'spaces', spaces: spacesOf(me.id) });
      return {};
    }
    case 'addChannel': {
      need();
      const s = db.spaces[b.spaceId];
      if (!s || !s.members.includes(me.id)) fail('Sem acesso');
      const name = clean(b.name, 30).toLowerCase().replace(/\s+/g, '-');
      if (!name) fail('Nome de canal inválido');
      s.channels.push({ id: 'c' + rnd(4), name, kind: 'text' });
      save();
      pushSpaces(s);
      return {};
    }
    case 'spaceHistory': {
      need();
      const s = db.spaces[b.spaceId];
      if (!s || !s.members.includes(me.id)) fail('Sem acesso');
      return { msgs: db.msgs[`sp:${s.id}:${b.channelId}`] || [] };
    }
    case 'spaceSend': {
      need();
      const s = db.spaces[b.spaceId];
      if (!s || !s.members.includes(me.id) || !s.channels.some(c => c.id === b.channelId)) fail('Sem acesso');
      const msg = buildMsg(me.id, b.msg);
      const key = `sp:${s.id}:${b.channelId}`;
      pushMsg(key, msg);
      s.members.forEach(id => emit(id, { t: 'spMsg', key, msg }));
      return { msg };
    }
    case 'call': {
      need();
      if (!me.contacts.includes(b.to)) fail('Adicione este contato para ligar');
      if (!streams.has(b.to) || streams.get(b.to).size === 0) return { ok: false, reason: 'offline' };
      if (busy.has(b.to)) return { ok: false, reason: 'busy' };
      if (busy.has(me.id)) fail('Você já está em uma chamada');
      if (typeof b.sdp !== 'string' || b.sdp.length > 200000) fail('Oferta de chamada inválida');
      const callId = rnd(8);
      const c = { a: me.id, b: b.to, video: !!b.video, status: 'ringing', timer: null };
      c.timer = setTimeout(() => endCall(callId, 'timeout'), 45000);
      calls.set(callId, c);
      busy.set(me.id, callId); busy.set(b.to, callId);
      emit(b.to, { t: 'ring', callId, from: pubLite(me), video: c.video, sdp: b.sdp });
      return { ok: true, callId };
    }
    case 'signal': {
      need();
      const c = calls.get(b.callId);
      if (!c || (c.a !== me.id && c.b !== me.id)) fail('Chamada não encontrada');
      const other = c.a === me.id ? c.b : c.a;
      if (b.kind === 'accept') { clearTimeout(c.timer); c.status = 'active'; emit(other, { t: 'signal', callId: b.callId, kind: 'accept' }); }
      else if (b.kind === 'decline') endCall(b.callId, 'declined');
      else if (b.kind === 'hangup' || b.kind === 'cancel') endCall(b.callId, c.status === 'ringing' && b.kind === 'cancel' ? 'cancelled' : 'hangup');
      else if (b.kind === 'answer' || b.kind === 'ice') emit(other, { t: 'signal', callId: b.callId, kind: b.kind, payload: b.payload ?? null });
      else fail('Sinal desconhecido');
      return {};
    }
    default: fail('Ação desconhecida');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      if (e) { res.writeHead(500); return res.end('index.html não encontrado'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(d);
    });
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    const tok = url.searchParams.get('token') || '';
    const uid = db.tokens[tok];
    if (!uid || !db.users[uid]) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    if (!streams.has(uid)) streams.set(uid, new Set());
    const first = streams.get(uid).size === 0;
    streams.get(uid).add(res);
    if (first) emitAll({ t: 'presence', online: onlineIds() });
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      const set = streams.get(uid);
      if (set) set.delete(res);
      if (!set || set.size === 0) {
        streams.delete(uid);
        const cid = busy.get(uid);
        if (cid) endCall(cid, 'offline');
        emitAll({ t: 'presence', online: onlineIds() });
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/rpc') {
    let size = 0;
    const chunks = [];
    req.on('data', c => { size += c.length; if (size > 40e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (e) { return send(400, { ok: false, error: 'JSON inválido' }); }
      const auth = tokenUser(req);
      try {
        const out = act(String(body.action || ''), body, auth ? auth.uid : null);
        send(200, { ok: true, ...out });
      } catch (e) {
        if (e instanceof AppErr) return send(200, { ok: false, error: e.message });
        console.error(e);
        send(500, { ok: false, error: 'Erro no servidor' });
      }
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Eco rodando em http://localhost:${PORT}`));
