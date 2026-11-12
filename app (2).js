// Shared helpers for all MultiPOS pages.
async function api(path, body, method) {
  const opts = { method: method || (body === undefined ? 'GET' : 'POST'), headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (res.status === 401 && !path.startsWith('/api/pair') && !location.pathname.startsWith('/login')) {
    location.href = '/login'; throw new Error('Please log in');
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c || 0) / 100).toFixed(2);
// "12.5" -> 1250 ; returns null if not a valid amount
function toCents(v) {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (!/^\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '.') return null;
  return Math.round(parseFloat(s) * 100);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer;
function toast(msg, kind = 'ok') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.className = 'show ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = ''), 2600);
}
function applyBrand(business) {
  if (business && business.accent_color) document.documentElement.style.setProperty('--accent', business.accent_color);
}
async function logout() { await api('/api/logout', {}); location.href = '/login'; }
