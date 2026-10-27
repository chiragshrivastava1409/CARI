// ============================================================
//  CARI - Campus Asset Recovery Intelligence  (Backend)
//  Node.js + Express  •  Login system with two roles:
//    student -> sign up & use the site right away (NO approval needed)
//    admin   -> sees the same site as students + an extra Admin Panel to check / delete reports
//  Admin ID / password live in the .env file (never in the code).
// ============================================================
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const { rankMatches, scorePair, aiVerify, blend, verdictFor } = require('./matcher');

// Tiny .env loader
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env file */ }

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'items.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

const readItems = () => JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const writeItems = (items) => fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const writeUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

// ---------- Admin credentials (from .env) ----------
const ADMIN_ID = (process.env.ADMIN_ID || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_ON = ADMIN_ID.length >= 3 && ADMIN_PASSWORD.length >= 8;
if (!ADMIN_ON) console.warn('⚠  Admin login is DISABLED. Set ADMIN_ID (3+ chars) and ADMIN_PASSWORD (8+ chars) in the .env file.');

// ---------- College settings (from .env) ----------
const COLLEGE = process.env.COLLEGE_NAME || 'MITS Gwalior';
const DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
let ENROLL_RE = null;
try { if (process.env.ENROLLMENT_REGEX) ENROLL_RE = new RegExp(process.env.ENROLLMENT_REGEX, 'i'); } catch (e) { console.warn('⚠  ENROLLMENT_REGEX is invalid and was ignored.'); }

// ---------- Session secret ----------
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) {
    const s = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();
const adminFp = () => crypto.createHash('sha256').update(`${ADMIN_ID}:${ADMIN_PASSWORD}:${SECRET}`).digest('hex').slice(0, 16);

// ---------- Password hashing (scrypt + random salt) ----------
const hashPw = async (pw, salt) => (await scrypt(String(pw), salt, 64)).toString('hex');
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// ---------- Signed session cookie ----------
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function makeToken(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${p}.${sign(p)}`;
}
function readToken(t) {
  if (!t) return null;
  const [p, s] = String(t).split('.');
  if (!p || !s) return null;
  const good = sign(p);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch (e) { return null; }
}
function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSession(req, res, payload, ms) {
  const token = makeToken({ ...payload, exp: Date.now() + ms });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `cari_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ms / 1000)}${secure ? '; Secure' : ''}`);
}
const clearSession = (res) => res.setHeader('Set-Cookie', 'cari_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');

// ---------- Tiny in-memory rate limiter ----------
const hits = new Map();
const recent = (key, win) => { const now = Date.now(); const a = (hits.get(key) || []).filter((t) => now - t < win); hits.set(key, a); return a; };
const addHit = (key, win) => recent(key, win).push(Date.now());
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 24 * 3600e3) hits.delete(k);
}, 3600e3).unref();
const MIN10 = 10 * 60 * 1000, HOUR = 3600e3, DAY = 24 * 3600e3;

// ---------- Global middleware ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
// Block cross-site form posts (extra CSRF protection on top of SameSite cookies)
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) throw new Error('x'); }
    catch (e) { return res.status(403).json({ error: 'Blocked: request came from another site' }); }
  }
  next();
});
app.use(express.json({ limit: '20kb' }));

// Who is logged in?  -> req.user  (or null)
app.use((req, res, next) => {
  req.user = null;
  const t = readToken(getCookie(req, 'cari_session'));
  if (t && t.role === 'admin') {
    if (ADMIN_ON && t.v === adminFp()) req.user = { id: 'admin', role: 'admin', name: 'Administrator', loginId: ADMIN_ID };
  } else if (t && t.role === 'student') {
    const u = readUsers().find((x) => x.id === t.uid);
    if (u && !u.blocked) req.user = { id: u.id, role: 'student', name: u.name, loginId: u.loginId };
  }
  next();
});
const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please login first' }));
const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please login first' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

// ============================================================
//  PAGES  (login page is public, the app needs a login)
// ============================================================
app.get('/login', (req, res) => (req.user ? res.redirect('/') : res.sendFile(path.join(PUBLIC_DIR, 'login.html'))));
// Everyone (student or admin) sees the same website; the admin just gets an extra Admin Panel inside it
app.get('/', (req, res) => (req.user ? res.sendFile(path.join(PUBLIC_DIR, 'index.html')) : res.redirect('/login')));
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if ((p === '/index.html' || p === '/script.js') && !req.user) return res.status(401).end();
  next();
});
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/api/public-config', (req, res) => res.json({ college: COLLEGE, emailDomains: DOMAINS }));
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use('/uploads', (req, res, next) => (req.user ? next() : res.status(401).end()), express.static(UPLOAD_DIR));

// ============================================================
//  AUTH
// ============================================================
// One login for everyone: the server decides if it is the admin or a student
app.post('/api/login', async (req, res) => {
  const loginId = String(req.body.loginId || '').trim().slice(0, 80);
  const password = String(req.body.password || '').slice(0, 200);
  if (!loginId || !password) return res.status(400).json({ error: 'Enter your ID and password' });

  const ipKey = 'fail-ip:' + req.ip, idKey = 'fail-id:' + loginId.toLowerCase();
  if (recent(ipKey, MIN10).length >= 20 || recent(idKey, MIN10).length >= 5) {
    return res.status(429).json({ error: 'Too many wrong attempts. Please try again after 10 minutes.' });
  }

  let session = null;
  if (ADMIN_ON && loginId.toLowerCase() === ADMIN_ID.toLowerCase()) {
    if (safeEqual(password, ADMIN_PASSWORD)) session = { role: 'admin', v: adminFp() };
  } else {
    const key = loginId.toLowerCase();
    const u = readUsers().find((x) => x.loginId === key || x.email === key);
    const hash = await hashPw(password, u ? u.salt : DUMMY_SALT);
    if (u && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash))) {
      if (u.blocked) return res.status(403).json({ error: 'Your account has been blocked by the admin.' });
      session = { role: 'student', uid: u.id };
    }
  }
  if (!session) {
    addHit(ipKey, MIN10); addHit(idKey, MIN10);
    return res.status(401).json({ error: 'Wrong ID or password' });
  }
  hits.delete(idKey);
  setSession(req, res, session, session.role === 'admin' ? 4 * HOUR : 7 * DAY);
  res.json({ ok: true, role: session.role, redirect: '/' });
});

// Student / staff sign-up (college members only)
app.post('/api/register', async (req, res) => {
  if (recent('reg:' + req.ip, HOUR).length >= 5) return res.status(429).json({ error: 'Too many sign-ups from this device. Try later.' });
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const loginId = String(req.body.loginId || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const branch = String(req.body.branch || '').trim().replace(/\s+/g, ' ');
  const kind = req.body.kind === 'staff' ? 'staff' : 'student';
  const password = String(req.body.password || '');
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Enter your full name' });
  if (!/^[a-z0-9@._-]{4,80}$/.test(loginId)) return res.status(400).json({ error: `${kind === 'staff' ? 'Employee ID' : 'Enrollment no.'} must be 4-80 characters (letters, numbers, @ . _ -)` });
  if (kind === 'student' && ENROLL_RE && !ENROLL_RE.test(loginId)) return res.status(400).json({ error: 'This enrollment number does not look right. Please check it.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 80) return res.status(400).json({ error: 'Enter a valid college email' });
  if (DOMAINS.length && !DOMAINS.some((d) => email.endsWith('@' + d) || email.endsWith('.' + d))) {
    return res.status(400).json({ error: `Please use your college email (${DOMAINS.map((d) => '@' + d).join(' or ')})` });
  }
  if (branch.length < 2 || branch.length > 60) return res.status(400).json({ error: 'Enter your branch & year (e.g. CSE 3rd year) or department' });
  if (password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (ADMIN_ON && (loginId === ADMIN_ID.toLowerCase() || email === ADMIN_ID.toLowerCase())) return res.status(400).json({ error: 'This ID is reserved. Choose another.' });

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPw(password, salt);
  const users = readUsers();
  if (users.some((u) => u.loginId === loginId || u.email === email || u.loginId === email || u.email === loginId)) {
    return res.status(409).json({ error: 'This ID or email is already registered. Please login.' });
  }
  const user = {
    id: crypto.randomUUID(), name: name.slice(0, 60), loginId, email, branch, kind, salt, hash,
    blocked: false, createdAt: Date.now(),
  };
  users.push(user); writeUsers(users);
  addHit('reg:' + req.ip, HOUR);
  setSession(req, res, { role: 'student', uid: user.id }, 7 * DAY);
  res.status(201).json({ ok: true, role: 'student', redirect: '/' });
});

app.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });
app.get('/api/me', requireAuth, (req, res) => res.json({ name: req.user.name, role: req.user.role, loginId: req.user.loginId }));

// ============================================================
//  REPORTS
// ============================================================
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(5).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (EXT[file.mimetype] ? cb(null, true) : cb(new Error('Only image files (jpg, png, webp, gif) are allowed'))),
});
const removePhoto = (photo) => { if (photo) try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(photo))); } catch (e) { /* already gone */ } };

// Hide private fields; tell the browser which reports belong to the viewer
const toPublic = (item, user) => {
  const { pinHash, ownerId, ...rest } = item;
  return { ...rest, mine: Boolean(user) && ownerId === user.id };
};

app.get('/api/items', requireAuth, (req, res) => {
  res.json(readItems().filter((i) => i.status === 'open').sort((a, b) => b.createdAt - a.createdAt).map((i) => toPublic(i, req.user)));
});

app.get('/api/stats', requireAuth, (req, res) => {
  const items = readItems();
  res.json({
    lost: items.filter((i) => i.status === 'open' && i.type === 'lost').length,
    found: items.filter((i) => i.status === 'open' && i.type === 'found').length,
    returned: items.filter((i) => i.status === 'returned').length,
  });
});

app.get('/api/ai-status', requireAuth, (req, res) => res.json({ ai: Boolean(process.env.ANTHROPIC_API_KEY) }));

app.get('/api/items/:id/matches', requireAuth, (req, res) => {
  const items = readItems();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const open = items.filter((i) => i.status === 'open');
  const matches = rankMatches(item, open).map((m) => ({
    ...toPublic(m.item, req.user),
    score: m.score, breakdown: m.breakdown, reasons: m.reasons, verdict: m.verdict, level: m.level,
  }));
  res.json({ item: toPublic(item, req.user), matches });
});

// CARI AI verification (needs ANTHROPIC_API_KEY)
const aiCache = new Map();
function readImage(photo) {
  if (!photo) return null;
  try {
    const file = path.join(UPLOAD_DIR, path.basename(photo));
    const buf = fs.readFileSync(file);
    const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    const media_type = types[path.extname(file).toLowerCase()];
    if (!media_type || buf.length > 4.5 * 1024 * 1024) return null;
    return { media_type, data: buf.toString('base64') };
  } catch (e) { return null; }
}
app.post('/api/match/ai', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI verification is off. Add ANTHROPIC_API_KEY in the .env file and restart the server.' });
  const key0 = 'ai:' + req.user.id;
  if (recent(key0, 60000).length >= 8) return res.status(429).json({ error: 'Too many AI checks. Please wait a minute.' });

  const items = readItems();
  const a = items.find((i) => i.id === req.body.a);
  const b = items.find((i) => i.id === req.body.b);
  if (!a || !b || a.type === b.type) return res.status(400).json({ error: 'Pick one lost and one found item' });

  const key = [a.id, b.id].sort().join(':');
  let ai = aiCache.get(key);
  if (!ai) {
    addHit(key0, 60000);
    try {
      ai = await aiVerify(a, b, { apiKey, model: process.env.CARI_AI_MODEL || 'claude-sonnet-5-5', readImage });
      aiCache.set(key, ai);
    } catch (e) {
      console.error('AI check failed:', e.message);
      return res.status(502).json({ error: 'AI check failed. Please try again later.' });
    }
  }
  const local = scorePair(a, b, items.filter((i) => i.status === 'open')).score;
  const finalScore = blend(local, ai.similarity);
  res.json({ finalScore, local, ai, ...verdictFor(finalScore) });
});

// New report (login required, max 10 per day for students)
app.post('/api/items', requireAuth, (req, res, next) => {
  if (req.user.role !== 'admin' && recent('post:' + req.user.id, DAY).length >= 10) {
    return res.status(429).json({ error: 'Daily limit reached (10 reports per day).' });
  }
  next();
}, upload.single('photo'), (req, res) => {
  const b = req.body;
  const fail = (msg) => { if (req.file) removePhoto(req.file.filename); return res.status(400).json({ error: msg }); };
  const required = ['type', 'title', 'category', 'description', 'location', 'date', 'contactName', 'contact', 'role'];
  for (const f of required) if (!b[f] || !String(b[f]).trim()) return fail(`Missing field: ${f}`);
  if (!['lost', 'found'].includes(b.type)) return fail('Invalid type');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || Number.isNaN(Date.parse(b.date))) return fail('Invalid date');

  const item = {
    id: crypto.randomUUID(),
    type: b.type,
    title: b.title.trim().slice(0, 80),
    category: b.category.trim().slice(0, 40),
    description: b.description.trim().slice(0, 500),
    location: b.location.trim().slice(0, 100),
    date: b.date,
    contactName: b.contactName.trim().slice(0, 60),
    contact: b.contact.trim().slice(0, 80),
    role: b.role === 'staff' ? 'staff' : 'student',
    photo: req.file ? '/uploads/' + req.file.filename : null,
    ownerId: req.user.id,
    status: 'open',
    createdAt: Date.now(),
  };
  const items = readItems();
  items.push(item); writeItems(items);
  addHit('post:' + req.user.id, DAY);
  res.status(201).json(toPublic(item, req.user));
});

// Close a report: only the person who posted it, or the admin
app.post('/api/items/:id/resolve', requireAuth, (req, res) => {
  const items = readItems();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (req.user.role !== 'admin' && item.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the person who posted this report can close it' });
  item.status = 'returned';
  writeItems(items);
  res.json({ ok: true });
});

// ============================================================
//  ADMIN ONLY
// ============================================================
// All reports (open + returned) so the admin can remove anything wrong
app.get('/api/admin/items', requireAdmin, (req, res) => {
  const byId = new Map(readUsers().map((u) => [u.id, u]));
  res.json(readItems().sort((a, b) => b.createdAt - a.createdAt).map(({ pinHash, ownerId, ...i }) => ({
    ...i,
    ownerName: ownerId === 'admin' ? 'Admin' : (byId.get(ownerId) ? byId.get(ownerId).name : 'Unknown'),
    ownerLoginId: byId.get(ownerId) ? byId.get(ownerId).loginId : '',
  })));
});

app.delete('/api/admin/items/:id', requireAdmin, (req, res) => {
  const items = readItems();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  removePhoto(item.photo);
  writeItems(items.filter((i) => i.id !== req.params.id));
  res.json({ ok: true });
});

// Error handler (wrong file type / file too big / etc.)
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Something went wrong' });
});

app.listen(PORT, () => console.log(`CARI running at http://localhost:${PORT}  (admin login: ${ADMIN_ON ? 'ON' : 'OFF'}${DOMAINS.length ? ', domains: ' + DOMAINS.join(',') : ''})`));
