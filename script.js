// ============================================================
//  CARI - Campus Asset Recovery Intelligence  (frontend logic)
// ============================================================
const CATEGORIES = [
  'ID Card', 'Wallet / Money', 'Phone / Electronics', 'Books / Notebook',
  'Keys', 'Bag', 'Clothes', 'Water Bottle / Lunch Box', 'Other',
];
const ICONS = {
  'ID Card': '🪪', 'Wallet / Money': '👛', 'Phone / Electronics': '📱', 'Books / Notebook': '📚',
  'Keys': '🔑', 'Bag': '🎒', 'Clothes': '🧥', 'Water Bottle / Lunch Box': '🍱', 'Other': '📦',
};

let allItems = [];
let tab = 'all';            // all | lost | found | mine
let category = 'All';
let aiEnabled = false;
let curItem = null;         // item whose matches are open
let curMatches = [];

let me = null;                // logged-in user {name, role, loginId}
const isAdmin = () => Boolean(me && me.role === 'admin');

// If the session ends (or the user is not logged in) send them to the login page
const _fetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const r = await _fetch(...args);
  if (r.status === 401) location.href = '/login';
  return r;
};

const SEEN_KEY = 'cari_seen';   // matches the user was already alerted about

const $ = (id) => document.getElementById(id);
const grid = $('grid');

// ---------- helpers ----------
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};

// Safe text: stops anyone injecting HTML/scripts into the page
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4200);
}
function niceDate(d) {
  const x = new Date(d + 'T00:00:00');
  return isNaN(x) ? d : x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function levelOf(score) { return score >= 55 ? 'hi' : score >= 35 ? 'mid' : 'lo'; }
function verdictOf(score) {
  return score >= 75 ? 'Very likely the same item' : score >= 55 ? 'Likely a match' : score >= 35 ? 'Possible match' : 'Weak match';
}
function contactHtml(i) {
  const isEmail = i.contact.includes('@');
  const phone = i.contact.replace(/[^\d+]/g, '');
  const link = isEmail ? `mailto:${encodeURIComponent(i.contact)}` : (phone.length >= 7 ? `tel:${phone}` : null);
  return `${esc(i.contactName)} <small>(${esc(i.role)})</small><br />
    ${link ? `<a href="${esc(link)}">${isEmail ? '✉️' : '📞'} ${esc(i.contact)}</a>` : `📞 ${esc(i.contact)}`}`;
}

// ---------- Theme ----------
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('themeBtn').textContent = t === 'dark' ? '☀️ Light mode' : '🌙 Dark mode';
  try { localStorage.setItem('theme', t); } catch (e) { /* ignore */ }
}
let savedTheme = null;
try { savedTheme = localStorage.getItem('theme'); } catch (e) { /* ignore */ }
setTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

// ---------- Sidebar (mobile) ----------
$('menuBtn').onclick = () => $('sidebar').classList.toggle('open');

// ---------- Category chips + form dropdown ----------
function buildChips() {
  $('chips').innerHTML = ['All', ...CATEGORIES].map((c) =>
    `<button class="chip ${c === category ? 'active' : ''}" data-cat="${esc(c)}">${c === 'All' ? '✨ All' : ICONS[c] + ' ' + esc(c)}</button>`).join('');
}
$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  category = b.dataset.cat; buildChips(); render();
});
$('formCategory').innerHTML = CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('');
buildChips();

// ---------- Sidebar tabs ----------
document.querySelectorAll('.nav-item[data-tab]').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('.nav-item[data-tab]').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); tab = b.dataset.tab; render();
  $('sidebar').classList.remove('open');
}));

// ---------- AI status ----------
async function initAi() {
  try {
    aiEnabled = (await fetch('/api/ai-status').then((r) => r.json())).ai;
  } catch (e) { aiEnabled = false; }
  $('aiState').textContent = aiEnabled ? '🧠 AI photo check: ON' : '🧠 Smart matching on (AI photo check off)';
}

// ---------- Load data ----------
async function loadItems() {
  grid.innerHTML = '<div class="skeleton"></div>'.repeat(3);
  try {
    const [items, stats] = await Promise.all([
      fetch('/api/items').then((r) => r.json()),
      fetch('/api/stats').then((r) => r.json()),
    ]);
    allItems = items;
    $('sLost').textContent = stats.lost;
    $('sFound').textContent = stats.found;
    $('sReturned').textContent = stats.returned;
  } catch (e) {
    allItems = [];
    toast('Could not reach the server. Is it running?');
  }
  render();
}

// ---------- Render list ----------
function render() {
  const q = $('search').value.trim().toLowerCase();
  let list = allItems.filter((i) => {
    if (tab === 'mine') { if (!i.mine) return false; }
    else if (tab !== 'all' && i.type !== tab) return false;
    if (category !== 'All' && i.category !== category) return false;
    if (q && !`${i.title} ${i.description} ${i.location} ${i.category}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if ($('sort').value === 'old') list = [...list].reverse();

  $('count').textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;
  $('empty').hidden = list.length > 0;
  if (tab === 'mine') {
    $('emptyTitle').textContent = 'You have no reports yet';
    $('emptyMsg').textContent = 'Reports you post with your account appear here, and CARI alerts you when a match shows up.';
  } else {
    $('emptyTitle').textContent = 'Nothing here yet';
    $('emptyMsg').textContent = 'Try a different search, or be the first to report an item.';
  }

  grid.innerHTML = list.map((i) => `
    <article class="card" data-id="${esc(i.id)}">
      <div class="thumb">
        ${i.photo ? `<img src="${esc(i.photo)}" alt="${esc(i.title)}" loading="lazy" />` : `<div class="noimg">${ICONS[i.category] || '📦'}</div>`}
        <span class="badge ${i.type}">${i.type}</span>
      </div>
      <div class="card-body">
        <h4>${esc(i.title)}</h4>
        <div class="meta"><span>📍 ${esc(i.location)}</span><span>📅 ${esc(niceDate(i.date))}</span></div>
        <span class="tag">${esc(i.category)}</span>
      </div>
    </article>`).join('');
}
['search', 'sort'].forEach((id) => $(id).addEventListener('input', render));

// ---------- Detail popup ----------
grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  const item = card && allItems.find((i) => i.id === card.dataset.id);
  if (item) showDetail(item);
});

function showDetail(i) {
  const heading = i.type === 'lost' ? 'Found this item? Contact the owner' : 'Is this yours? Contact the finder';
  $('detailContent').innerHTML = `
    <div class="d-top"><span class="pill ${i.type}">${i.type}</span><small>${esc(i.category)}</small></div>
    <h3>${esc(i.title)}</h3>
    ${i.photo ? `<img class="d-img" src="${esc(i.photo)}" alt="" />` : ''}
    <p>${esc(i.description)}</p>
    <div class="d-grid">
      <div class="d-box"><small>📍 Place</small>${esc(i.location)}</div>
      <div class="d-box"><small>📅 Date</small>${esc(niceDate(i.date))}</div>
    </div>
    <button class="btn-ai" id="matchBtn">🧠 Find AI matches for this ${esc(i.type)} item</button>
    <div class="contact" style="margin-top:14px">
      <b>${heading}</b><br />${contactHtml(i)}
    </div>
    ${(i.mine || isAdmin()) ? `<div class="resolve">
      <b>Item returned / sorted out?</b><br />
      <small>${isAdmin() && !i.mine ? 'Admin: you can close or delete this report.' : 'Close your report once the item is back with its owner.'}</small>
      <div class="r-row"><button id="resolveBtn">Mark as returned</button>${isAdmin() ? '<button id="delBtn" class="danger">Delete report</button>' : ''}</div>
      <p id="resolveMsg" class="error"></p>
    </div>` : ''}`;
  $('detailModal').hidden = false;

  $('matchBtn').onclick = () => { $('detailModal').hidden = true; showMatches(i); };

  if ($('resolveBtn')) $('resolveBtn').onclick = async () => {
    const res = await fetch(`/api/items/${i.id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    if (res.ok) { $('detailModal').hidden = true; toast('🎉 Marked as returned. Great!'); loadItems(); }
    else $('resolveMsg').textContent = data.error || 'Could not update';
  };
  if ($('delBtn')) $('delBtn').onclick = async () => {
    if (!confirm('Delete this report permanently?')) return;
    const res = await fetch(`/api/admin/items/${i.id}`, { method: 'DELETE' });
    if (res.ok) { $('detailModal').hidden = true; toast('🗑️ Report deleted'); loadItems(); }
    else $('resolveMsg').textContent = (await res.json()).error || 'Could not delete';
  };
}

// ============================================================
//  CARI MATCH RESULTS
// ============================================================
async function fetchMatches(id) {
  const res = await fetch(`/api/items/${id}/matches`);
  if (!res.ok) throw new Error('Could not load matches');
  return res.json();
}

async function showMatches(item, { auto = false } = {}) {
  curItem = item; curMatches = [];
  if (!auto) {
    $('matchSub').textContent = `Comparing your ${item.type} report “${item.title}” with all open ${item.type === 'lost' ? 'found' : 'lost'} reports…`;
    $('matchBody').innerHTML = '<div class="skeleton" style="height:150px"></div>';
    $('matchModal').hidden = false;
  }
  let data;
  try { data = await fetchMatches(item.id); }
  catch (e) { if (!auto) $('matchBody').innerHTML = '<p class="error">Could not load matches. Is the server running?</p>'; return; }

  curMatches = data.matches;
  if (!curMatches.length) {
    if (auto) { toast('Report saved. No similar items yet — CARI will alert you when one appears 🔔'); return; }
    $('matchSub').textContent = '';
    $('matchBody').innerHTML = `<div class="none-box"><div>🔎</div><h4>No similar items yet</h4>
      <p>CARI keeps watching. Open <b>My Reports</b> later — you'll get a 🔔 alert when a similar item is reported.</p></div>`;
    return;
  }
  $('matchSub').textContent = `${curMatches.length} possible match${curMatches.length > 1 ? 'es' : ''} for “${item.title}” — best first.`;
  $('matchBody').innerHTML = curMatches.map(matchCard).join('') +
    `<p class="m-note">${aiEnabled
      ? '🧠 Use “Verify with AI” to compare photos and details more deeply before you contact someone.'
      : 'Scores come from CARI’s smart matching on description, category, place and date. Add an API key to switch on AI photo verification.'}</p>`;
  $('matchModal').hidden = false;
}

function bar(label, v) {
  return `<div class="bar-row"><span>${label}</span><div class="bar"><i style="width:${v}%"></i></div><span>${v}%</span></div>`;
}
function matchCard(m) {
  const b = m.breakdown;
  return `
  <div class="mcard" data-id="${esc(m.id)}">
    <div class="m-top">
      <div class="ring ${m.level}" style="--p:${m.score}"><b>${m.score}%</b></div>
      <div class="m-info">
        <span class="pill ${m.type}">${esc(m.type)}</span>
        <h4>${esc(m.title)}</h4>
        <small>📍 ${esc(m.location)} • 📅 ${esc(niceDate(m.date))}</small><br />
        <span class="verdict ${m.level}">${esc(m.verdict)}</span>
      </div>
      ${m.photo ? `<img class="m-img" src="${esc(m.photo)}" alt="" />` : ''}
    </div>
    <div class="bars">
      ${bar('Description', b.description)}${bar('Category', b.category)}${bar('Place', b.place)}${bar('Date', b.date)}
    </div>
    <ul class="reasons">${m.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <div class="m-ai" hidden></div>
    <div class="m-actions">
      ${aiEnabled ? '<button class="btn-sm ai" data-act="ai">🧠 Verify with AI</button>' : ''}
      <button class="btn-sm" data-act="contact">📞 Show contact</button>
      <button class="btn-sm" data-act="open">👁 View report</button>
    </div>
    <div class="contact m-contact" hidden>${contactHtml(m)}</div>
  </div>`;
}

$('matchBody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('.mcard');
  const m = curMatches.find((x) => x.id === card.dataset.id);
  if (!m) return;
  if (btn.dataset.act === 'contact') card.querySelector('.m-contact').hidden = !card.querySelector('.m-contact').hidden;
  if (btn.dataset.act === 'open') { $('matchModal').hidden = true; showDetail(m); }
  if (btn.dataset.act === 'ai') verifyAi(btn, card, m);
});

async function verifyAi(btn, card, m) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '🧠 Analysing photos & details…';
  try {
    const res = await fetch('/api/match/ai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: curItem.id, b: m.id }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'AI check failed');

    const lvl = levelOf(d.finalScore);
    const ring = card.querySelector('.ring');
    ring.className = `ring ${lvl}`; ring.style.setProperty('--p', d.finalScore);
    ring.querySelector('b').textContent = `${d.finalScore}%`;
    const v = card.querySelector('.verdict');
    v.className = `verdict ${lvl}`; v.textContent = verdictOf(d.finalScore);

    const ai = d.ai;
    const photos = ai.usedPhotos.lost && ai.usedPhotos.found ? 'both photos compared'
      : (ai.usedPhotos.lost || ai.usedPhotos.found) ? 'only one photo available' : 'no photos available — text only';
    const box = card.querySelector('.m-ai');
    box.innerHTML = `<b style="margin-top:0">🧠 AI verdict: ${ai.similarity}% similar <small>(${photos})</small></b>
      ${ai.matching.length ? `<b>✅ What matches</b><ul>${ai.matching.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${ai.differences.length ? `<b>⚠️ Differences</b><ul>${ai.differences.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${ai.advice ? `<b>💡 Ask to confirm ownership</b>${esc(ai.advice)}` : ''}`;
    box.hidden = false;
    btn.textContent = '✔ Verified by AI';
  } catch (err) {
    toast(err.message);
    btn.disabled = false; btn.textContent = label;
  }
}

// ---------- Alerts for my own reports ----------
async function checkMyMatches() {
  const mineOpen = allItems.filter((i) => i.mine).slice(0, 8);
  const seen = store.get(SEEN_KEY, {});
  let withMatch = 0;
  for (const it of mineOpen) {
    try {
      const d = await fetchMatches(it.id);
      const strong = d.matches.filter((m) => m.score >= 55);
      if (!strong.length) continue;
      withMatch++;
      const fresh = strong.find((m) => !seen[`${it.id}:${m.id}`]);
      if (fresh) {
        seen[`${it.id}:${fresh.id}`] = 1;
        toast(`🔔 Possible match for “${it.title}” — ${fresh.score}%. Open My Reports → View it.`);
      }
    } catch (e) { /* ignore */ }
  }
  store.set(SEEN_KEY, seen);
  const badge = $('mineBadge');
  badge.hidden = !withMatch; badge.textContent = withMatch;
}

// ---------- Popups ----------
function openForm(type) {
  if (type) $(type === 'found' ? 'tFound' : 'tLost').checked = true;
  $('formError').hidden = true;
  $('formModal').hidden = false;
}
$('openFormBtn').onclick = () => openForm();
document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openForm(b.dataset.open)));
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => ($(b.dataset.close).hidden = true)));
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) m.hidden = true; }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)); });

// ---------- Photo picker with preview + drag & drop ----------
const photo = $('photo'), drop = $('drop');
function showPreview() {
  const f = photo.files[0];
  if (!f) { $('preview').hidden = true; $('dropText').hidden = false; return; }
  $('preview').src = URL.createObjectURL(f);
  $('preview').hidden = false; $('dropText').hidden = true;
}
photo.addEventListener('change', showPreview);
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) { photo.files = e.dataTransfer.files; showPreview(); }
});

// ---------- Submit ----------
function today() { return new Date().toISOString().slice(0, 10); }
$('dateInput').value = today(); $('dateInput').max = today();

$('itemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, btn = $('submitBtn');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const res = await fetch('/api/items', { method: 'POST', body: new FormData(form) });
    const data = await res.json();
    if (!res.ok) { $('formError').textContent = data.error || 'Could not submit'; $('formError').hidden = false; return; }

    form.reset(); showPreview(); $('dateInput').value = today();
    $('formModal').hidden = true;
    toast('✅ Report submitted! CARI is checking for matches…');
    await loadItems();
    const saved = allItems.find((i) => i.id === data.id);
    if (saved) showMatches(saved, { auto: true });   // opens results if something similar exists
    checkMyMatches();
  } catch (err) {
    $('formError').textContent = 'Server not reachable. Please try again.'; $('formError').hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Submit report';
  }
});

// ============================================================
//  USER BOX + LOGOUT
// ============================================================
function setupUser() {
  $('userName').textContent = me.name;
  $('userRole').textContent = isAdmin() ? 'Admin' : 'Student';
  $('userAv').textContent = me.name.trim().charAt(0).toUpperCase() || '?';
  $('adminBtn').hidden = !isAdmin();
  if (!isAdmin()) {
    const f = document.querySelector('#itemForm [name=contactName]');
    f.defaultValue = me.name; f.value = me.name;   // pre-fill, reset() keeps it
  }
}
$('logoutBtn').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; };

// ============================================================
//  ADMIN PANEL  (only the admin account sees / can use this)
// ============================================================
let adminItems = [];
$('adminBtn').onclick = () => { $('adminModal').hidden = false; $('adminBody').innerHTML = '<div class="skeleton" style="height:140px"></div>'; loadAdmin(); $('sidebar').classList.remove('open'); };
$('adminSearch').addEventListener('input', renderAdmin);
async function loadAdmin() {
  try {
    const res = await fetch('/api/admin/items');
    if (!res.ok) throw new Error();
    adminItems = await res.json(); renderAdmin();
  } catch (e) { $('adminBody').innerHTML = '<p class="error">Could not load reports.</p>'; }
}
function renderAdmin() {
  const q = $('adminSearch').value.trim().toLowerCase();
  const list = adminItems.filter((i) => !q || [i.title, i.category, i.location, i.description, i.ownerName, i.ownerLoginId].join(' ').toLowerCase().includes(q));
  $('adminBody').innerHTML = list.length ? `<div class="a-scroll"><table class="a-table">
    <tr><th>Type</th><th>Item</th><th>Posted by</th><th>Date</th><th>Status</th><th>Action</th></tr>
    ${list.map((i) => `<tr>
      <td><span class="pill ${esc(i.type)}">${esc(i.type)}</span></td>
      <td><b>${esc(i.title)}</b><br /><small>${esc(i.category)} • ${esc(i.location)}</small></td>
      <td>${esc(i.ownerName)}<br /><small>${esc(i.ownerLoginId)}</small></td>
      <td>${esc(niceDate(i.date))}</td>
      <td><span class="a-tag ${i.status === 'open' ? 'ok' : ''}">${esc(i.status)}</span></td>
      <td><button class="a-btn danger" data-id="${esc(i.id)}">Delete</button></td></tr>`).join('')}
  </table></div>` : '<p class="a-empty">No reports found.</p>';
}
$('adminBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-id]');
  if (!b || !confirm('Delete this report permanently?')) return;
  const res = await fetch(`/api/admin/items/${b.dataset.id}`, { method: 'DELETE' });
  if (res.ok) { toast('🗑️ Report deleted'); await loadAdmin(); loadItems(); }
  else toast('Could not delete');
});

// ---------- Start ----------
(async function start() {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) return;
    me = await r.json();
  } catch (e) { toast('Could not reach the server. Is it running?'); return; }
  setupUser();
  initAi();
  await loadItems();
  checkMyMatches();
})();
