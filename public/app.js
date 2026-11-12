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
// Photo address for a product; v changes whenever the photo changes.
const productImg = (id, v) => `/api/products/${id}/image?v=${v}`;

// Shrinks a picked/taken photo to a square-ish JPEG (max 600px) so uploads stay small.
function resizeImage(file, max = 600) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) return reject(new Error('Choose an image file'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // white behind transparent PNGs
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be opened')); };
    img.src = url;
  });
}
// ---------- receipts ----------
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
// Receipt HTML used by the printed receipt and the customer's link.
function receiptHtml(s) {
  const pay = { cash: 'Cash', card: 'Card', other: 'Other' }[s.payment_method] || s.payment_method;
  return `<div class="c">${s.logo_url ? `<img src="${esc(s.logo_url)}" alt="">` : ''}<h1>${esc(s.business_name)}</h1>
    <div>${esc(s.location_name)}</div>${s.location_address ? `<div>${esc(s.location_address)}</div>` : ''}${s.location_phone ? `<div>${esc(s.location_phone)}</div>` : ''}</div>
    <hr><div class="l"><span>Sale #${s.id}</span><span>${fmtDateTime(s.created_at)}</span></div>
    ${s.cashier ? `<div>Cashier: ${esc(s.cashier)}</div>` : ''}
    ${s.voided ? '<div class="void">VOID</div>' : ''}<hr>
    ${s.items.map((it) => `<div class="l"><span>${esc(it.name)}${it.taxable ? '' : ' (NT)'}</span><span>${money(it.line_cents)}</span></div>
      ${it.qty > 1 ? `<div>&nbsp;&nbsp;${it.qty} @ ${money(it.unit_cents)}</div>` : ''}`).join('')}
    <hr><div class="l"><span>Subtotal</span><span>${money(s.subtotal_cents)}</span></div>
    <div class="l"><span>Tax (${Number(s.tax_rate)}%)</span><span>${money(s.tax_cents)}</span></div>
    <div class="l big"><span>TOTAL</span><span>${money(s.total_cents)}</span></div><hr>
    <div class="l"><span>Paid by ${esc(pay)}</span><span>${money(s.tendered_cents ?? s.total_cents)}</span></div>
    ${s.payment_method === 'cash' ? `<div class="l"><span>Change</span><span>${money(s.change_cents || 0)}</span></div>` : ''}
    <hr><div class="c">Thank you!</div>`;
}
// Plain-text receipt for a WhatsApp message.
function receiptText(s, url) {
  const pay = { cash: 'Cash', card: 'Card', other: 'Other' }[s.payment_method] || s.payment_method;
  const lines = [`*${s.business_name}*`, s.location_name, `Receipt #${s.id} · ${fmtDateTime(s.created_at)}`, ''];
  const shown = s.items.slice(0, 25);
  for (const it of shown) lines.push(`${it.qty} × ${it.name} — ${money(it.line_cents)}`);
  if (s.items.length > shown.length) lines.push(`…and ${s.items.length - shown.length} more items`);
  lines.push('', `Subtotal: ${money(s.subtotal_cents)}`, `Tax (${Number(s.tax_rate)}%): ${money(s.tax_cents)}`,
    `*Total: ${money(s.total_cents)}*`, `Paid: ${pay}`);
  if (s.payment_method === 'cash' && s.change_cents) lines.push(`Change: ${money(s.change_cents)}`);
  if (s.voided) lines.push('', 'THIS SALE WAS VOIDED');
  lines.push('', `View your receipt: ${url}`, '', 'Thank you!');
  return lines.join('\n');
}
// "(512) 555-1234" -> "15125551234". 10 digits are treated as a US number.
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) d = '1' + d;
  return d;
}

// Opens a small dialog: enter the customer's number, then WhatsApp opens with the receipt ready to send.
async function openWhatsAppDialog(saleId) {
  let back = $('#waModal');
  if (!back) {
    back = document.createElement('div');
    back.className = 'modal-back'; back.id = 'waModal';
    back.innerHTML = `<form class="modal" id="waForm">
      <h2>Send receipt on WhatsApp</h2>
      <div class="muted" id="waInfo">Loading…</div>
      <label for="waPhone">Customer's WhatsApp number</label>
      <input id="waPhone" type="tel" inputmode="tel" autocomplete="off" placeholder="(512) 555-1234">
      <div class="muted" style="font-size:13px;margin-top:4px">US numbers need no country code. Other countries: start with the country code. Leave blank to pick a contact in WhatsApp.</div>
      <div class="err" id="waErr"></div>
      <div class="actions"><button type="button" class="ghost" id="waCancel">Cancel</button><button class="primary" id="waSend" disabled>Open WhatsApp</button></div>
    </form>`;
    document.body.appendChild(back);
    $('#waCancel').onclick = () => back.classList.remove('open');
  }
  const form = $('#waForm');
  $('#waPhone').value = ''; $('#waErr').textContent = ''; $('#waInfo').textContent = 'Loading…'; $('#waSend').disabled = true;
  back.classList.add('open'); $('#waPhone').focus();
  let text;
  try {
    // Fetch first so the Send click can open WhatsApp right away (browsers block delayed pop-ups).
    const r = await api(`/api/sales/${saleId}/share`, {});
    text = receiptText(r.sale, r.url);
    $('#waInfo').textContent = `Receipt #${r.sale.id} · ${money(r.sale.total_cents)}`;
    $('#waSend').disabled = false;
  } catch (e) { $('#waInfo').textContent = ''; $('#waErr').textContent = e.message; }
  form.onsubmit = (e) => {
    e.preventDefault();
    const raw = $('#waPhone').value.trim();
    const num = waNumber(raw);
    if (raw && (num.length < 8 || num.length > 15)) { $('#waErr').textContent = 'That phone number does not look right'; return; }
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    back.classList.remove('open');
    if (typeof focusScan === 'function') focusScan();
  };
}
async function logout() { await api('/api/logout', {}); location.href = '/login'; }
