// CARI - login / sign-up page logic
const $ = (id) => document.getElementById(id);
const form = $('authForm');
let mode = 'login';
let cfg = { college: '', emailDomains: [] };

fetch('/api/public-config').then((r) => r.json()).then((c) => {
  cfg = c;
  if (c.college) $('collegeName').textContent = c.college;
  if (c.emailDomains.length) $('domainHint').textContent = '(' + c.emailDomains.map((d) => '@' + d).join(' / ') + ')';
}).catch(() => {});

// keep the same light/dark theme as the main app
try { document.documentElement.dataset.theme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch (e) { /* ignore */ }

function setMode(m) {
  mode = m;
  const reg = m === 'register';
  document.querySelectorAll('.auth-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  ['nameRow', 'kindRow', 'emailRow', 'branchRow'].forEach((id) => ($(id).hidden = !reg));
  $('pw2Row').hidden = !reg;
  $('authTitle').textContent = reg ? 'Create your student account' : 'Welcome back 👋';
  $('authSub').textContent = reg ? 'For college members only. Sign up and start using CARI instantly.' : 'Students and Admin both login here.';
  $('idLabel').textContent = reg ? 'Enrollment No. (Staff: Employee ID)' : 'Enrollment No. / Email / Admin ID';
  $('authBtn').textContent = reg ? 'Create account' : 'Login';
  $('pw').autocomplete = reg ? 'new-password' : 'current-password';
  $('authFoot').innerHTML = reg ? 'Already have an account? Click <b>Login</b> above.' : 'New student? Click <b>Student Sign up</b> above.';
  $('authError').hidden = true;
}
document.querySelectorAll('.auth-tabs button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

$('pwToggle').onclick = () => { $('pw').type = $('pw').type === 'password' ? 'text' : 'password'; };

function showError(msg) { $('authError').textContent = msg; $('authError').hidden = false; }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  if (!f.loginId.trim() || !f.password) return showError('Please fill in all fields');
  if (mode === 'register') {
    if (!f.name.trim() || !f.email.trim() || !f.branch.trim()) return showError('Please fill in all fields');
    if (f.password !== f.password2) return showError('Passwords do not match');
    if (f.password.length < 6) return showError('Password must be at least 6 characters');
  }
  const btn = $('authBtn'), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Please wait…'; $('authError').hidden = true;
  try {
    const res = await fetch(mode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.name, kind: f.kind, loginId: f.loginId, email: f.email, branch: f.branch, password: f.password }),
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Something went wrong');
    location.href = data.redirect || '/';
  } catch (err) {
    showError('Server not reachable. Is it running?');
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
});
