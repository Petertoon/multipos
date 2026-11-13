// Email receipts for MultiPOS, sent through Resend (resend.com).
//
// Server settings (Render > Environment):
//   RESEND_API_KEY        the API key from resend.com > API Keys
//   RECEIPT_FROM_EMAIL    the address receipts come from (default receipts@lokaalhub.com).
//                         Its domain must be verified in Resend.
// Each email shows the store's name as the sender, and replies go to the store's
// "reply-to" address (Settings), or to the store owner's login email.
const API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const FROM = () => process.env.RECEIPT_FROM_EMAIL || 'receipts@lokaalhub.com';
const configured = () => !!process.env.RESEND_API_KEY;

const PAY = { cash: 'Cash', card: 'Card', other: 'Other', gift_card: 'Gift card', check: 'Check', account: 'Charge account', split: 'Split' };
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const when = (d, tz) => new Date(d).toLocaleString('en-US', { timeZone: tz || 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });

function paidBy(s) {
  const p = s.payments || [];
  if (p.length > 1) return 'Split: ' + p.map((x) => `${PAY[x.method] || x.method} ${money(x.amount_cents)}`).join(' + ');
  const m = (p[0] && p[0].method) || s.payment_method;
  const chk = p[0] && p[0].check_number ? ` #${p[0].check_number}` : '';
  return (PAY[m] || m) + chk;
}

function build(s, url, tz) {
  const subject = `${s.voided ? 'VOIDED - ' : ''}Your receipt from ${s.business_name} - ${money(s.total_cents)}`;
  const row = (l, r, bold) => `<tr><td style="padding:3px 8px 3px 0;white-space:nowrap;${bold ? 'font-weight:700;font-size:17px' : 'color:#555'}">${l}</td>
    <td align="right" style="padding:3px 0;${bold ? 'font-weight:700;font-size:17px' : ''}">${r}</td></tr>`;
  const items = s.items.slice(0, 200).map((it) => `<tr>
      <td style="padding:6px 0;border-bottom:1px solid #eee">${esc(it.name)}${it.qty !== 1 ? `<div style="color:#777;font-size:13px">${it.qty} × ${money(it.unit_cents)}</div>` : ''}</td>
      <td align="right" valign="top" style="padding:6px 0;border-bottom:1px solid #eee;white-space:nowrap">${money(it.line_cents)}</td></tr>`).join('');
  const more = s.items.length > 200 ? `<tr><td colspan="2" style="padding:6px 0;color:#777">…and ${s.items.length - 200} more items</td></tr>` : '';
  const job = [s.po_number && `PO: ${esc(s.po_number)}`, s.job_address && `Job site: ${esc(s.job_address)}`].filter(Boolean).join('<br>');
  const rentals = (s.rentals || []).map((r) => `<div style="margin-top:10px;padding:10px;background:#fff7e6;border-radius:6px">
      <b>Rental #${r.id}: ${esc(r.item_name)}${r.qty > 1 ? ' ×' + r.qty : ''}</b><br>Due back: <b>${esc(when(r.due_at, tz))}</b></div>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f2f2f0;font-family:Arial,Helvetica,sans-serif;color:#1d1d1b">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f0;padding:24px 10px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:10px;padding:24px">
<tr><td>
  ${s.logo_url ? `<img src="${esc(s.logo_url)}" alt="" style="max-height:60px;max-width:200px;display:block;margin:0 auto 10px">` : ''}
  <div style="text-align:center;font-size:20px;font-weight:700">${esc(s.business_name)}</div>
  <div style="text-align:center;color:#666;font-size:14px;margin-top:4px">${esc(s.location_name)}${s.location_address ? '<br>' + esc(s.location_address) : ''}${s.location_phone ? '<br>' + esc(s.location_phone) : ''}</div>
  ${s.voided ? '<div style="margin-top:14px;padding:10px;text-align:center;background:#fdecea;color:#b3261e;font-weight:700;border-radius:6px">THIS SALE WAS VOIDED</div>' : ''}
  <div style="margin-top:18px;color:#555;font-size:14px">Receipt #${s.id} · ${esc(when(s.created_at, tz))}${s.customer_name ? '<br>Customer: ' + esc(s.customer_name) : ''}${job ? '<br>' + job : ''}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;font-size:15px">${items}${more}</table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;font-size:15px">
    ${row('Subtotal', money(s.subtotal_cents))}
    ${row(`Tax (${Number(s.tax_rate)}%)`, money(s.tax_cents))}
    ${row('Total', money(s.total_cents), true)}
    ${row('Paid', esc(paidBy(s)))}
    ${s.change_cents ? row('Change', money(s.change_cents)) : ''}
  </table>
  ${rentals}
  <div style="text-align:center;margin-top:22px"><a href="${esc(url)}" style="display:inline-block;background:#1f8f4e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">View or print receipt</a></div>
  <div style="text-align:center;margin-top:20px;color:#888;font-size:13px">Thank you for your business!</div>
</td></tr></table>
<div style="color:#999;font-size:12px;margin-top:12px">Sent for ${esc(s.business_name)} by MultiPOS</div>
</td></tr></table></body></html>`;
  const lines = [s.business_name, s.location_name, `Receipt #${s.id} · ${when(s.created_at, tz)}`, ''];
  if (s.voided) lines.push('THIS SALE WAS VOIDED', '');
  for (const it of s.items.slice(0, 200)) lines.push(`${it.qty} x ${it.name} - ${money(it.line_cents)}`);
  lines.push('', `Subtotal: ${money(s.subtotal_cents)}`, `Tax: ${money(s.tax_cents)}`, `Total: ${money(s.total_cents)}`, `Paid: ${paidBy(s)}`);
  for (const r of s.rentals || []) lines.push('', `Rental #${r.id}: ${r.item_name}`, `Due back: ${when(r.due_at, tz)}`);
  lines.push('', `View or print your receipt: ${url}`, '', 'Thank you!');
  return { subject, html, text: lines.join('\n') };
}

module.exports = function emailReceipts(app, h) {
  const { pool, wrap, fail, requireLogin, requireBusiness, publicOrigin, SALE_SELECT, saleWithItems, token } = h;
  const biz = [requireLogin, requireBusiness];
  // Keeps any one store from using up the shared daily sending limit.
  const daily = new Map();
  const PER_STORE_PER_DAY = Number(process.env.RECEIPT_EMAILS_PER_STORE_PER_DAY || 300);

  app.post('/api/sales/:id/email', ...biz, wrap(async (req, res) => {
    if (!configured()) fail(400, 'Email receipts are not set up on this server yet (RESEND_API_KEY).');
    const to = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(to) || to.length > 200) fail(400, 'That email address does not look right');
    const bizId = req.user.business_id;
    const day = new Date().toISOString().slice(0, 10);
    const k = bizId + ':' + day;
    if ((daily.get(k) || 0) >= PER_STORE_PER_DAY) fail(429, 'Too many receipt emails today. Try again tomorrow.');

    await pool.query('UPDATE sales SET receipt_token = $1 WHERE id = $2 AND business_id = $3 AND receipt_token IS NULL', [token(16), req.params.id, bizId]);
    const r = await pool.query(`${SALE_SELECT} WHERE s.id = $1 AND s.business_id = $2`, [req.params.id, bizId]);
    if (!r.rows[0]) fail(404, 'Sale not found');
    if (r.rows[0].receipt_email_count >= 5) fail(429, 'This receipt has already been emailed 5 times.');
    const sale = await saleWithItems(r.rows[0]);
    const b = (await pool.query(
      `SELECT b.time_zone, b.receipt_reply_email, (SELECT email FROM users WHERE business_id=b.id AND role='owner' AND active ORDER BY id LIMIT 1) AS owner_email
         FROM businesses b WHERE b.id=$1`, [bizId])).rows[0];
    const url = `${publicOrigin(req)}/r#${sale.receipt_token}`;
    const msg = build(sale, url, b.time_zone);
    const fromName = String(sale.business_name || 'MultiPOS').replace(/["<>\r\n]/g, '').slice(0, 60);
    const replyTo = b.receipt_reply_email || b.owner_email;

    let resp, body;
    try {
      resp = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
          'Idempotency-Key': `mp-${bizId}-${sale.id}-${sale.receipt_email_count + 1}-${to}`.slice(0, 256) },
        body: JSON.stringify({ from: `${fromName} <${FROM()}>`, to: [to], subject: msg.subject, html: msg.html, text: msg.text,
          ...(replyTo ? { reply_to: replyTo } : {}) }),
      });
      body = await resp.json().catch(() => ({}));
    } catch (e) { fail(502, 'Could not reach the email service. Try again.'); }
    if (!resp.ok) {
      console.error('Receipt email failed', resp.status, body);
      fail(502, 'The email service said: ' + (body.message || resp.status));
    }
    daily.set(k, (daily.get(k) || 0) + 1);
    if (daily.size > 500) for (const key of daily.keys()) if (!key.endsWith(day)) daily.delete(key);
    await pool.query('UPDATE sales SET receipt_emailed_to=$1, receipt_emailed_at=now(), receipt_email_count=receipt_email_count+1 WHERE id=$2', [to, sale.id]);
    // Remember the email on the customer's record if it was empty.
    let saved = false;
    if (sale.customer_id && req.body.save_to_customer !== false) {
      const u = await pool.query(`UPDATE customers SET email=$1 WHERE id=$2 AND business_id=$3 AND (email IS NULL OR email='')`, [to, sale.customer_id, bizId]);
      saved = u.rowCount > 0;
    }
    res.json({ ok: true, to, saved_to_customer: saved });
  }));
};
module.exports.configured = configured;
