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
const PAY_NAMES = { cash: 'Cash', card: 'Card', other: 'Other', gift_card: 'Gift card', check: 'Check', account: 'Charge account' };
// Account balance: "$120.00" owed, or "Credit $48.37" when they've paid ahead.
const balText = (c) => (c < 0 ? `Credit ${money(-c)}` : money(c));
// Google Maps link for a job site (GPS if known, otherwise the address).
function mapLink(lat, lng, address) {
  if (lat != null && lng != null && lat !== '' && lng !== '') return `https://www.google.com/maps?q=${Number(lat)},${Number(lng)}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return null;
}
// Customer / PO / job site block shared by receipts and quotes.
function jobHtml(s) {
  const gps = s.job_lat != null && s.job_lng != null ? `${Number(s.job_lat).toFixed(5)}, ${Number(s.job_lng).toFixed(5)}` : '';
  const rows = [];
  if (s.customer_name) rows.push(`<div>Customer: <b>${esc(s.customer_name)}</b>${s.customer_company ? ' · ' + esc(s.customer_company) : ''}</div>`);
  if (s.po_number) rows.push(`<div>PO #: <b>${esc(s.po_number)}</b></div>`);
  if (s.job_address) rows.push(`<div>Job site: ${esc(s.job_address)}</div>`);
  if (gps) rows.push(`<div>GPS: ${esc(gps)}</div>`);
  return rows.length ? `<hr>${rows.join('')}` : '';
}
function jobText(s) {
  const out = [];
  if (s.customer_name) out.push(`Customer: ${s.customer_name}`);
  if (s.po_number) out.push(`PO #: ${s.po_number}`);
  if (s.job_address) out.push(`Job site: ${s.job_address}`);
  const link = s.job_lat != null && s.job_lng != null ? mapLink(s.job_lat, s.job_lng) : null;
  if (link) out.push(`Location: ${link}`);
  return out;
}
// "Cash" or "Split: Cash $20.00 + Card $3.26"
function paidByText(s) {
  const p = s.payments || [];
  if (p.length > 1) return 'Split: ' + p.map((x) => `${PAY_NAMES[x.method] || x.method} ${money(x.amount_cents)}`).join(' + ');
  return PAY_NAMES[(p[0] && p[0].method) || s.payment_method] || s.payment_method;
}
// Receipt lines for how the sale was paid.
function paymentLines(s) {
  const p = s.payments && s.payments.length ? s.payments
    : [{ method: s.payment_method, amount_cents: s.total_cents, tendered_cents: s.tendered_cents, change_cents: s.change_cents }];
  return p.map((x) => {
    const name = PAY_NAMES[x.method] || x.method;
    if (x.method === 'cash' && x.tendered_cents != null && x.tendered_cents !== x.amount_cents) {
      return { label: `${name} (received ${money(x.tendered_cents)})`, amount: x.amount_cents, change: x.change_cents };
    }
    if (x.method === 'check' && x.check_number) return { label: `Check #${x.check_number}`, amount: x.amount_cents, change: 0 };
    return { label: name, amount: x.amount_cents, change: 0 };
  });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
// Receipt HTML used by the printed receipt and the customer's link.
function receiptHtml(s) {
  return `<div class="c">${s.logo_url ? `<img src="${esc(s.logo_url)}" alt="">` : ''}<h1>${esc(s.business_name)}</h1>
    <div>${esc(s.location_name)}</div>${s.location_address ? `<div>${esc(s.location_address)}</div>` : ''}${s.location_phone ? `<div>${esc(s.location_phone)}</div>` : ''}</div>
    <hr><div class="l"><span>Sale #${s.id}</span><span>${fmtDateTime(s.created_at)}</span></div>
    ${s.cashier ? `<div>Cashier: ${esc(s.cashier)}</div>` : ''}
    ${jobHtml(s)}
    ${s.voided ? '<div class="void">VOID</div>' : ''}<hr>
    ${s.items.map((it) => `<div class="l"><span>${esc(it.name)}${it.taxable ? '' : ' (NT)'}</span><span>${money(it.line_cents)}</span></div>
      ${it.qty > 1 ? `<div>&nbsp;&nbsp;${it.qty} @ ${money(it.unit_cents)}</div>` : ''}`).join('')}
    <hr><div class="l"><span>Subtotal</span><span>${money(s.subtotal_cents)}</span></div>
    <div class="l"><span>Tax (${Number(s.tax_rate)}%)</span><span>${money(s.tax_cents)}</span></div>
    <div class="l big"><span>TOTAL</span><span>${money(s.total_cents)}</span></div><hr>
    ${(() => {
      const lines = paymentLines(s);
      const change = lines.reduce((a, l) => a + (l.change || 0), 0);
      return (lines.length > 1 ? '<div>Paid with:</div>' : '') +
        lines.map((l) => `<div class="l"><span>${lines.length > 1 ? '&nbsp;&nbsp;' : 'Paid by '}${esc(l.label)}</span><span>${money(l.amount)}</span></div>`).join('') +
        (lines.some((l) => l.label.startsWith('Cash')) ? `<div class="l"><span>Change</span><span>${money(change)}</span></div>` : '');
    })()}
    ${s.rentals && s.rentals.length ? `<hr><div><b>RENTAL${s.rentals.length > 1 ? 'S' : ''}</b></div>${s.rentals.map((r) =>
      `<div>#${r.id} ${esc(r.item_name)}${r.qty > 1 ? ' ×' + r.qty : ''}</div><div class="l"><span>&nbsp;&nbsp;Due back</span><span><b>${fmtDateTime(r.due_at)}</b></span></div>`).join('')}
      <div>Renter: ${esc(s.rentals[0].customer_name)}</div>` : ''}
    ${(s.payments || []).some((p) => p.method === 'account') ? '<hr><div>Charged to account. Signature:</div><div style="height:28px;border-bottom:1px solid #000"></div>' : ''}
    <hr><div class="c">Thank you!</div>`;
}
// Printed quote.
function quoteHtml(q) {
  const items = q.cart || [];
  return `<div class="c">${q.logo_url ? `<img src="${esc(q.logo_url)}" alt="">` : ''}<h1>${esc(q.business_name)}</h1>
    <div>${esc(q.location_name || '')}</div>${q.location_address ? `<div>${esc(q.location_address)}</div>` : ''}${q.location_phone ? `<div>${esc(q.location_phone)}</div>` : ''}</div>
    <hr><div class="c big">PRICE QUOTE #${q.id}</div>
    <div class="l"><span>Date</span><span>${fmtDateTime(q.created_at)}</span></div>
    ${q.valid_until ? `<div class="l"><span>Good until</span><span><b>${new Date(q.valid_until + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</b></span></div>` : ''}
    ${q.customer_phone ? `<div class="l"><span>Phone</span><span>${esc(q.customer_phone)}</span></div>` : ''}
    ${jobHtml(q)}<hr>
    ${items.map((it) => `<div class="l"><span>${esc(it.name)}${it.taxable ? '' : ' (NT)'}</span><span>${money(it.unit_cents * it.qty)}</span></div>
      ${it.qty > 1 ? `<div>&nbsp;&nbsp;${it.qty} @ ${money(it.unit_cents)}</div>` : ''}`).join('')}
    <hr><div class="l"><span>Subtotal</span><span>${money(q.subtotal_cents)}</span></div>
    <div class="l"><span>Tax (${Number(q.tax_rate)}%)</span><span>${money(q.tax_cents)}</span></div>
    <div class="l big"><span>TOTAL</span><span>${money(q.total_cents)}</span></div>
    ${q.note ? `<hr><div>${esc(q.note)}</div>` : ''}
    ${q.status === 'sold' ? '<div class="void">SOLD</div>' : q.status === 'canceled' ? '<div class="void">CANCELED</div>' : ''}
    <hr><div class="c">This is a quote, not a receipt.</div>`;
}
function quoteText(q) {
  const lines = [`*${q.business_name}*`, q.location_name || '', `*Price quote #${q.id}* · ${fmtDateTime(q.created_at)}`];
  if (q.valid_until) lines.push(`Good until ${new Date(q.valid_until + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`);
  lines.push(...jobText(q), '');
  for (const it of (q.cart || []).slice(0, 30)) lines.push(`${it.qty} × ${it.name} — ${money(it.unit_cents * it.qty)}`);
  lines.push('', `Subtotal: ${money(q.subtotal_cents)}`, `Tax (${Number(q.tax_rate)}%): ${money(q.tax_cents)}`, `*Total: ${money(q.total_cents)}*`);
  if (q.note) lines.push('', q.note);
  lines.push('', `Mention quote #${q.id} when you order. Thank you!`);
  return lines.join('\n');
}
// Plain-text receipt for a WhatsApp message.
function receiptText(s, url) {
  const lines = [`*${s.business_name}*`, s.location_name, `Receipt #${s.id} · ${fmtDateTime(s.created_at)}`, ...jobText(s), ''];
  const shown = s.items.slice(0, 25);
  for (const it of shown) lines.push(`${it.qty} × ${it.name} — ${money(it.line_cents)}`);
  if (s.items.length > shown.length) lines.push(`…and ${s.items.length - shown.length} more items`);
  lines.push('', `Subtotal: ${money(s.subtotal_cents)}`, `Tax (${Number(s.tax_rate)}%): ${money(s.tax_cents)}`,
    `*Total: ${money(s.total_cents)}*`, `Paid: ${paidByText(s)}`);
  if (s.change_cents) lines.push(`Change: ${money(s.change_cents)}`);
  for (const r of s.rentals || []) lines.push('', `Rental #${r.id}: ${r.item_name}${r.qty > 1 ? ' ×' + r.qty : ''}`, `*Due back: ${fmtDateTime(r.due_at)}*`);
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

// How this computer sends WhatsApp messages (saved per device):
//   'app' = the installed WhatsApp Desktop app
//   'web' = WhatsApp Web, always reusing ONE browser tab so it stays logged in
const WA_TAB = 'multipos_whatsapp';
function waMode() { try { return localStorage.getItem('mp_wa_mode') || 'app'; } catch (e) { return 'app'; } }
function setWaMode(m) { try { localStorage.setItem('mp_wa_mode', m); } catch (e) { /* ok */ } }
function openWhatsApp() {
  if (waMode() === 'app') { launchLink('whatsapp://'); return; }
  window.open('https://web.whatsapp.com/', WA_TAB);
}
function sendToWhatsApp(num, text) {
  const q = (num ? `phone=${num}&` : '') + `text=${encodeURIComponent(text)}`;
  if (waMode() === 'app') launchLink(`whatsapp://send?${q}`);
  else window.open(`https://web.whatsapp.com/send?${q}`, WA_TAB);
}
// Opens an app link (whatsapp://) without leaving the POS page.
function launchLink(href) { const a = document.createElement('a'); a.href = href; document.body.appendChild(a); a.click(); a.remove(); }

// Small "WhatsApp" box: choose the app or WhatsApp Web, and open it.
function mountWhatsAppBox(el) {
  el.innerHTML = `<div class="wabox">
    <div class="wahead"><span class="walogo">🟢</span><b>WhatsApp receipts</b></div>
    <label class="check"><input type="radio" name="waMode" value="app"> WhatsApp Desktop app</label>
    <label class="check"><input type="radio" name="waMode" value="web"> WhatsApp Web (one tab)</label>
    <button class="wa" type="button" data-open>Open WhatsApp</button>
    <div class="muted wanote"></div></div>`;
  const note = el.querySelector('.wanote');
  const sync = () => {
    const m = waMode();
    el.querySelectorAll('input[name=waMode]').forEach((r) => { r.checked = r.value === m; });
    note.textContent = m === 'app'
      ? 'Receipts open in the WhatsApp app on this computer. It must be installed and signed in.'
      : 'Receipts open in one WhatsApp Web tab that stays signed in. Sign in once with the QR code.';
  };
  el.querySelectorAll('input[name=waMode]').forEach((r) => r.addEventListener('change', () => { setWaMode(r.value); sync(); }));
  el.querySelector('[data-open]').addEventListener('click', openWhatsApp);
  sync();
}

// Opens a small dialog: enter the customer's number, then WhatsApp opens with the receipt ready to send.
// Pass a sale id, or { title, info, text, phone } for any other message (like a quote).
async function openWhatsAppDialog(saleId) {
  const custom = typeof saleId === 'object' && saleId ? saleId : null;
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
      <div class="muted" id="waVia" style="font-size:13px;margin-top:10px"></div>
      <div class="err" id="waErr"></div>
      <div class="actions"><button type="button" class="ghost" id="waCancel">Cancel</button><button class="primary" id="waSend" disabled>Open WhatsApp</button></div>
    </form>`;
    document.body.appendChild(back);
    $('#waCancel').onclick = () => back.classList.remove('open');
  }
  const form = $('#waForm');
  $('#waVia').textContent = waMode() === 'app'
    ? 'Opens in the WhatsApp Desktop app. (Change this on the checkout screen, in the WhatsApp box.)'
    : 'Opens in your WhatsApp Web tab. (Change this on the checkout screen, in the WhatsApp box.)';
  $('#waPhone').value = ''; $('#waErr').textContent = ''; $('#waInfo').textContent = 'Loading…'; $('#waSend').disabled = true;
  $('#waForm h2').textContent = custom ? (custom.title || 'Send on WhatsApp') : 'Send receipt on WhatsApp';
  back.classList.add('open'); $('#waPhone').focus();
  let text;
  if (custom) {
    text = custom.text; $('#waInfo').textContent = custom.info || ''; $('#waPhone').value = custom.phone || ''; $('#waSend').disabled = false;
  } else try {
    // Fetch first so the Send click can open WhatsApp right away (browsers block delayed pop-ups).
    const r = await api(`/api/sales/${saleId}/share`, {});
    text = receiptText(r.sale, r.url);
    $('#waInfo').textContent = `Receipt #${r.sale.id} · ${money(r.sale.total_cents)}`;
    if (r.sale.customer_phone) $('#waPhone').value = r.sale.customer_phone;
    $('#waSend').disabled = false;
  } catch (e) { $('#waInfo').textContent = ''; $('#waErr').textContent = e.message; }
  form.onsubmit = (e) => {
    e.preventDefault();
    const raw = $('#waPhone').value.trim();
    const num = waNumber(raw);
    if (raw && (num.length < 8 || num.length > 15)) { $('#waErr').textContent = 'That phone number does not look right'; return; }
    sendToWhatsApp(num, text);
    back.classList.remove('open');
    if (typeof focusScan === 'function') focusScan();
  };
}
// ---------- Text and email receipts ----------
// Short text message with the receipt link (texts should stay short).
function smsText(s, url) {
  return `${s.business_name}: receipt #${s.id}, total ${money(s.total_cents)}.${s.voided ? ' (VOIDED)' : ''} View it here: ${url}`;
}
// A small reusable dialog. Returns the elements so each sender fills it in.
function sendDialog(id, title, field) {
  let back = $('#' + id);
  if (!back) {
    back = document.createElement('div');
    back.className = 'modal-back'; back.id = id;
    back.innerHTML = `<form class="modal">
      <h2>${title}</h2>
      <div class="muted" data-info>Loading…</div>
      <label>${field.label}</label>
      <input data-field type="${field.type}" inputmode="${field.inputmode}" autocomplete="off" placeholder="${field.placeholder}">
      <div class="muted" data-note style="font-size:13px;margin-top:6px">${field.note}</div>
      <div class="err" data-err></div>
      <div class="actions"><button type="button" class="ghost" data-cancel>Cancel</button><button class="primary" data-send disabled>${field.button}</button></div>
    </form>`;
    document.body.appendChild(back);
    back.querySelector('[data-cancel]').onclick = () => back.classList.remove('open');
  }
  const q = (k) => back.querySelector(`[data-${k}]`);
  q('field').value = ''; q('err').textContent = ''; q('info').textContent = 'Loading…'; q('send').disabled = true;
  back.classList.add('open'); q('field').focus();
  return { back, form: back.querySelector('form'), q };
}
async function openTextDialog(saleId) {
  const d = sendDialog('smsModal', 'Text the receipt', { label: "Customer's cell number", type: 'tel', inputmode: 'tel', placeholder: '(512) 555-1234',
    note: 'Opens the Messages app on this device with the receipt link ready, then tap Send. Works on phones and tablets (on a Windows PC it needs Phone Link).',
    button: 'Open Messages' });
  let text;
  try {
    const r = await api(`/api/sales/${saleId}/share`, {});
    text = smsText(r.sale, r.url);
    d.q('info').textContent = `Receipt #${r.sale.id} · ${money(r.sale.total_cents)}`;
    if (r.sale.customer_phone) d.q('field').value = r.sale.customer_phone;
    d.q('send').disabled = false;
  } catch (e) { d.q('info').textContent = ''; d.q('err').textContent = e.message; }
  d.form.onsubmit = (e) => {
    e.preventDefault();
    let num = d.q('field').value.replace(/[^\d+]/g, '');
    const digits = num.replace(/\D/g, '');
    if (digits.length === 10 && !num.startsWith('+')) num = '+1' + digits;
    if (num && (digits.length < 10 || digits.length > 15)) { d.q('err').textContent = 'That phone number does not look right'; return; }
    launchLink(`sms:${num}?&body=${encodeURIComponent(text)}`);
    d.back.classList.remove('open');
    if (typeof focusScan === 'function') focusScan();
  };
}
async function openEmailDialog(saleId) {
  const d = sendDialog('emailModal', 'Email the receipt', { label: "Customer's email", type: 'email', inputmode: 'email', placeholder: 'name@example.com',
    note: 'The receipt is emailed right away. Replies go to the store.', button: 'Send email' });
  const ready = typeof me === 'undefined' || !me.features || me.features.email_receipts;
  if (!ready) { d.q('info').textContent = ''; d.q('err').textContent = 'Email receipts are not set up on this server yet.'; return; }
  try {
    const r = await api(`/api/sales/${saleId}/share`, {});
    d.q('info').textContent = `Receipt #${r.sale.id} · ${money(r.sale.total_cents)}${r.sale.receipt_emailed_to ? ` · last emailed to ${r.sale.receipt_emailed_to}` : ''}`;
    d.q('field').value = r.sale.customer_email || r.sale.receipt_emailed_to || '';
    d.q('send').disabled = false;
  } catch (e) { d.q('info').textContent = ''; d.q('err').textContent = e.message; }
  d.form.onsubmit = async (e) => {
    e.preventDefault();
    const email = d.q('field').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { d.q('err').textContent = 'That email address does not look right'; return; }
    d.q('send').disabled = true; d.q('send').textContent = 'Sending…'; d.q('err').textContent = '';
    try {
      const r = await api(`/api/sales/${saleId}/email`, { email });
      d.back.classList.remove('open');
      toast(`Receipt emailed to ${r.to}${r.saved_to_customer ? ' (saved to the customer)' : ''}`);
      if (typeof focusScan === 'function') focusScan();
    } catch (err) { d.q('err').textContent = err.message; }
    finally { d.q('send').disabled = false; d.q('send').textContent = 'Send email'; }
  };
}
// One "Send" button that lets the cashier pick how.
function openSendChooser(saleId) {
  let back = $('#sendChoose');
  if (!back) {
    back = document.createElement('div'); back.className = 'modal-back'; back.id = 'sendChoose';
    back.innerHTML = `<div class="modal" style="text-align:center"><h2>Send receipt</h2>
      <div class="sendgrid"><button class="wa" data-how="wa">WhatsApp</button><button class="ghost" data-how="sms">💬 Text</button><button class="ghost" data-how="email">✉️ Email</button></div>
      <div class="actions" style="justify-content:center"><button class="ghost" data-x>Cancel</button></div></div>`;
    document.body.appendChild(back);
    back.querySelector('[data-x]').onclick = () => back.classList.remove('open');
  }
  back.querySelectorAll('[data-how]').forEach((b) => { b.onclick = () => {
    back.classList.remove('open');
    ({ wa: openWhatsAppDialog, sms: openTextDialog, email: openEmailDialog })[b.dataset.how](saleId);
  }; });
  back.classList.add('open');
}
async function logout() { await api('/api/logout', {}); location.href = '/login'; }
