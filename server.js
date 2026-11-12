// MultiPOS server: login, businesses, locations, registers, products, checkout,
// phone scanner pairing, and live cart updates (Server-Sent Events).
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const { pool, init } = require('./db');

const app = express();
app.set('trust proxy', 1);
// Photo uploads need a bigger body limit than everything else.
const jsonSmall = express.json({ limit: '200kb' });
const jsonLarge = express.json({ limit: '4mb' });
app.use((req, res, next) => (req.path.endsWith('/image') ? jsonLarge : jsonSmall)(req, res, next));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Camera barcode reader for the phone page, served from this app (no outside CDN needed).
app.get('/vendor/html5-qrcode.min.js', (req, res) =>
  res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js')));

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const SESSION_DAYS = 14;
const COOKIE = 'mp_session';

// ---------- helpers ----------
const token = (n = 24) => crypto.randomBytes(n).toString('hex');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function cents(value, label = 'Amount') {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 100000000) fail(400, `${label} is not valid`);
  return n;
}
function text(value, label, { required = true, max = 200 } = {}) {
  const s = (value ?? '').toString().trim();
  if (required && !s) fail(400, `${label} is required`);
  if (s.length > max) fail(400, `${label} is too long`);
  return s;
}
function computeTotals(cart, taxRate) {
  let subtotal = 0, taxable = 0, count = 0;
  for (const it of cart) {
    const line = it.unit_cents * it.qty;
    subtotal += line;
    if (it.taxable) taxable += line;
    count += it.qty;
  }
  const tax = Math.round((taxable * Number(taxRate)) / 100 + 1e-9);
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax, item_count: count };
}
// Scanners report UPC-A as 12 digits or as 13 digits with a leading 0; match either.
function barcodeVariants(code) {
  const c = code.trim();
  const out = new Set([c]);
  if (/^\d{12}$/.test(c)) out.add('0' + c);
  if (/^0\d{12}$/.test(c)) out.add(c.slice(1));
  return [...out];
}
function publicOrigin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// ---------- auth ----------
async function loadUser(req) {
  const t = req.cookies[COOKIE];
  if (!t) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.business_id AS own_business_id, s.acting_business_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now() AND u.active`, [t]);
  const u = rows[0];
  if (!u) return null;
  u.business_id = u.role === 'admin' ? u.acting_business_id : u.own_business_id;
  return u;
}
const requireLogin = wrap(async (req, res, next) => {
  req.user = await loadUser(req);
  if (!req.user) fail(401, 'Please log in');
  next();
});
const requireBusiness = (req, res, next) => {
  if (!req.user.business_id) return next(new HttpError(400, 'Choose a business first'));
  next();
};
// Platform admin counts as an owner inside the business they have entered.
const requireRole = (...roles) => (req, res, next) => {
  const role = req.user.role === 'admin' ? 'owner' : req.user.role;
  if (!roles.includes(role)) return next(new HttpError(403, 'You do not have permission for this'));
  next();
};
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Platform administrators only'));
  next();
};

// Simple brute-force protection for login.
const loginAttempts = new Map();
function checkLoginRate(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key) || { n: 0, t: now };
  if (now - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++;
  loginAttempts.set(key, rec);
  if (rec.n > 20) fail(429, 'Too many login attempts. Try again in 15 minutes.');
}

async function startSession(res, userId) {
  const t = token();
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [t, userId]);
  res.cookie(COOKIE, t, {
    httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: SESSION_DAYS * 86400000,
  });
}

app.get('/api/setup-status', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  res.json({ needs_setup: rows[0].n === 0 });
}));

// First-run only: creates the platform administrator account.
app.post('/api/setup', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) fail(403, 'Setup has already been completed');
  const name = text(req.body.name, 'Name');
  const email = text(req.body.email, 'Email').toLowerCase();
  const password = text(req.body.password, 'Password', { max: 200 });
  if (password.length < 8) fail(400, 'Password must be at least 8 characters');
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'admin') RETURNING id`,
    [name, email, hash]);
  await startSession(res, r.rows[0].id);
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  checkLoginRate(req.ip);
  const email = text(req.body.email, 'Email').toLowerCase();
  const password = (req.body.password || '').toString();
  const { rows } = await pool.query(
    `SELECT u.id, u.password_hash, u.active, u.role, b.active AS biz_active
       FROM users u LEFT JOIN businesses b ON b.id = u.business_id WHERE u.email = $1`, [email]);
  const u = rows[0];
  if (!u || !u.active || !(await bcrypt.compare(password, u.password_hash))) fail(401, 'Wrong email or password');
  if (u.role !== 'admin' && u.biz_active === false) fail(403, 'This business account is turned off');
  await startSession(res, u.id);
  res.json({ ok: true, role: u.role });
}));

app.post('/api/logout', wrap(async (req, res) => {
  if (req.cookies[COOKIE]) await pool.query('DELETE FROM sessions WHERE token = $1', [req.cookies[COOKIE]]);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}));

app.get('/api/me', requireLogin, wrap(async (req, res) => {
  let business = null;
  if (req.user.business_id) {
    const b = await pool.query('SELECT id, name, accent_color, logo_url FROM businesses WHERE id = $1', [req.user.business_id]);
    business = b.rows[0] || null;
  }
  const { id, name, email, role } = req.user;
  res.json({ user: { id, name, email, role }, business });
}));

app.post('/api/me/password', requireLogin, wrap(async (req, res) => {
  const current = (req.body.current || '').toString();
  const next = text(req.body.password, 'New password');
  if (next.length < 8) fail(400, 'Password must be at least 8 characters');
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(current, rows[0].password_hash))) fail(400, 'Current password is wrong');
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(next, 10), req.user.id]);
  res.json({ ok: true });
}));

// ---------- platform admin ----------
app.get('/api/admin/businesses', requireLogin, requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT b.*,
      (SELECT count(*) FROM locations l WHERE l.business_id = b.id)::int AS location_count,
      (SELECT count(*) FROM users u WHERE u.business_id = b.id)::int AS user_count,
      (SELECT email FROM users u WHERE u.business_id = b.id AND u.role = 'owner' ORDER BY u.id LIMIT 1) AS owner_email
    FROM businesses b ORDER BY b.name`);
  res.json(rows);
}));

// Creates a business, its owner login, and a first location with one register.
app.post('/api/admin/businesses', requireLogin, requireAdmin, wrap(async (req, res) => {
  const name = text(req.body.name, 'Business name');
  const ownerName = text(req.body.owner_name, 'Owner name');
  const ownerEmail = text(req.body.owner_email, 'Owner email').toLowerCase();
  const ownerPassword = text(req.body.owner_password, 'Owner password');
  if (ownerPassword.length < 8) fail(400, 'Owner password must be at least 8 characters');
  const locationName = text(req.body.location_name || 'Main Location', 'Location name');
  const taxRate = Number(req.body.tax_rate ?? 8.25);
  if (!(taxRate >= 0 && taxRate < 30)) fail(400, 'Tax rate is not valid');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT 1 FROM users WHERE email = $1', [ownerEmail]);
    if (exists.rowCount) fail(400, 'That owner email is already in use');
    const b = await client.query('INSERT INTO businesses (name) VALUES ($1) RETURNING id', [name]);
    const bid = b.rows[0].id;
    await client.query(
      `INSERT INTO users (business_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'owner')`,
      [bid, ownerName, ownerEmail, await bcrypt.hash(ownerPassword, 10)]);
    const l = await client.query(
      'INSERT INTO locations (business_id, name, tax_rate) VALUES ($1,$2,$3) RETURNING id', [bid, locationName, taxRate]);
    await client.query('INSERT INTO registers (location_id, name, pair_token) VALUES ($1,$2,$3)',
      [l.rows[0].id, 'Register 1', token(16)]);
    await client.query('COMMIT');
    res.json({ id: bid });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

app.put('/api/admin/businesses/:id', requireLogin, requireAdmin, wrap(async (req, res) => {
  await pool.query('UPDATE businesses SET active = $1 WHERE id = $2', [!!req.body.active, req.params.id]);
  res.json({ ok: true });
}));

// Lets the platform admin work inside a business (support / setup).
app.post('/api/admin/enter/:id', requireLogin, requireAdmin, wrap(async (req, res) => {
  const b = await pool.query('SELECT id FROM businesses WHERE id = $1', [req.params.id]);
  if (!b.rowCount) fail(404, 'Business not found');
  await pool.query('UPDATE sessions SET acting_business_id = $1 WHERE token = $2', [req.params.id, req.cookies[COOKIE]]);
  res.json({ ok: true });
}));
app.post('/api/admin/exit', requireLogin, requireAdmin, wrap(async (req, res) => {
  await pool.query('UPDATE sessions SET acting_business_id = NULL WHERE token = $1', [req.cookies[COOKIE]]);
  res.json({ ok: true });
}));

// Everything below is scoped to the logged-in user's business.
const biz = [requireLogin, requireBusiness];
const managers = [...biz, requireRole('owner', 'manager')];

// ---------- business settings ----------
app.put('/api/business', ...biz, requireRole('owner'), wrap(async (req, res) => {
  const name = text(req.body.name, 'Business name');
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.accent_color || '') ? req.body.accent_color : '#1f8f4e';
  const logo = text(req.body.logo_url, 'Logo URL', { required: false, max: 500 });
  if (logo && !/^https:\/\//.test(logo)) fail(400, 'Logo URL must start with https://');
  await pool.query('UPDATE businesses SET name=$1, accent_color=$2, logo_url=$3 WHERE id=$4',
    [name, color, logo || null, req.user.business_id]);
  res.json({ ok: true });
}));

// ---------- locations ----------
app.get('/api/locations', ...biz, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM locations WHERE business_id = $1 ORDER BY name', [req.user.business_id]);
  res.json(rows);
}));
function locationFields(body) {
  const tax = Number(body.tax_rate);
  if (!(tax >= 0 && tax < 30)) fail(400, 'Tax rate is not valid');
  return [text(body.name, 'Location name'), text(body.address, 'Address', { required: false, max: 300 }),
    text(body.phone, 'Phone', { required: false, max: 40 }), tax, body.active !== false];
}
app.post('/api/locations', ...biz, requireRole('owner'), wrap(async (req, res) => {
  const f = locationFields(req.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO locations (business_id, name, address, phone, tax_rate, active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [req.user.business_id, ...f]);
    await client.query('INSERT INTO registers (location_id, name, pair_token) VALUES ($1,$2,$3)',
      [r.rows[0].id, 'Register 1', token(16)]);
    await client.query('COMMIT');
    res.json({ id: r.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
app.put('/api/locations/:id', ...biz, requireRole('owner'), wrap(async (req, res) => {
  const f = locationFields(req.body);
  const r = await pool.query(
    `UPDATE locations SET name=$1, address=$2, phone=$3, tax_rate=$4, active=$5
      WHERE id=$6 AND business_id=$7`, [...f, req.params.id, req.user.business_id]);
  if (!r.rowCount) fail(404, 'Location not found');
  res.json({ ok: true });
}));

// ---------- registers ----------
async function getRegister(id, businessId) {
  const { rows } = await pool.query(
    `SELECT r.*, l.name AS location_name, l.tax_rate, l.business_id, l.address AS location_address,
            l.phone AS location_phone
       FROM registers r JOIN locations l ON l.id = r.location_id
      WHERE r.id = $1 AND l.business_id = $2`, [id, businessId]);
  if (!rows[0]) fail(404, 'Register not found');
  return rows[0];
}
app.get('/api/registers', ...biz, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.active, r.location_id, l.name AS location_name
       FROM registers r JOIN locations l ON l.id = r.location_id
      WHERE l.business_id = $1 AND l.active ORDER BY l.name, r.name`, [req.user.business_id]);
  res.json(rows);
}));
app.post('/api/registers', ...managers, wrap(async (req, res) => {
  const loc = await pool.query('SELECT id FROM locations WHERE id=$1 AND business_id=$2',
    [req.body.location_id, req.user.business_id]);
  if (!loc.rowCount) fail(404, 'Location not found');
  const r = await pool.query('INSERT INTO registers (location_id, name, pair_token) VALUES ($1,$2,$3) RETURNING id',
    [req.body.location_id, text(req.body.name, 'Register name'), token(16)]);
  res.json({ id: r.rows[0].id });
}));
app.put('/api/registers/:id', ...managers, wrap(async (req, res) => {
  await getRegister(req.params.id, req.user.business_id);
  await pool.query('UPDATE registers SET name=$1, active=$2 WHERE id=$3',
    [text(req.body.name, 'Register name'), req.body.active !== false, req.params.id]);
  res.json({ ok: true });
}));
// Makes a new pairing QR code; phones paired with the old one stop working.
app.post('/api/registers/:id/new-pair', ...biz, wrap(async (req, res) => {
  await getRegister(req.params.id, req.user.business_id);
  await pool.query('UPDATE registers SET pair_token=$1 WHERE id=$2', [token(16), req.params.id]);
  broadcast(req.params.id, { type: 'paired-reset' });
  res.json({ ok: true });
}));

// ---------- live updates (Server-Sent Events) ----------
const listeners = new Map(); // registerId -> Set of responses
function broadcast(registerId, payload) {
  const set = listeners.get(String(registerId));
  if (!set) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(msg);
}
app.get('/api/registers/:id/events', ...biz, wrap(async (req, res) => {
  await getRegister(req.params.id, req.user.business_id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const key = String(req.params.id);
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); listeners.get(key)?.delete(res); });
}));

// ---------- cart ----------
// Locks the register row, applies a change to its cart, saves, and notifies screens.
async function mutateCart(registerId, businessId, fn, source) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT r.id, r.cart, r.active, l.tax_rate FROM registers r JOIN locations l ON l.id = r.location_id
        WHERE r.id = $1 AND l.business_id = $2 FOR UPDATE OF r`, [registerId, businessId]);
    if (!rows[0]) fail(404, 'Register not found');
    const cart = rows[0].cart || [];
    const result = await fn(cart, client);
    if (cart.length > 300) fail(400, 'Cart is too large');
    await client.query('UPDATE registers SET cart = $1 WHERE id = $2', [JSON.stringify(cart), registerId]);
    await client.query('COMMIT');
    const totals = computeTotals(cart, rows[0].tax_rate);
    broadcast(registerId, { type: 'cart', cart, totals, source, event: result?.event });
    return { cart, totals, ...result };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
// Product columns without the photo bytes (never load photos in lists).
const PRODUCT_COLS = `id, business_id, barcode, name, category, price_cents, taxable, track_stock, stock_qty,
  active, created_at, (image IS NOT NULL) AS has_image,
  CASE WHEN image IS NOT NULL THEN floor(extract(epoch FROM image_updated_at))::bigint END AS image_version`;
function addProductToCart(cart, p, qty = 1) {
  const existing = cart.find((it) => it.product_id === p.id);
  if (existing) { existing.qty += qty; existing.img = p.image_version ? Number(p.image_version) : null; }
  else cart.push({ key: token(6), product_id: p.id, barcode: p.barcode, name: p.name,
    unit_cents: p.price_cents, qty, taxable: p.taxable, img: p.image_version ? Number(p.image_version) : null });
  return existing || cart[cart.length - 1];
}
async function scanIntoCart(registerId, businessId, code, source) {
  code = text(code, 'Code', { max: 100 });
  return mutateCart(registerId, businessId, async (cart, client) => {
    const { rows } = await client.query(
      `SELECT ${PRODUCT_COLS} FROM products WHERE business_id = $1 AND active AND barcode = ANY($2) LIMIT 1`,
      [businessId, barcodeVariants(code)]);
    if (!rows[0]) return { found: false, code, event: { kind: 'not-found', code } };
    const item = addProductToCart(cart, rows[0]);
    return { found: true, item, event: { kind: 'added', name: rows[0].name } };
  }, source);
}
function customItem(body) {
  const name = text(body.name, 'Description', { required: false, max: 120 }) || 'Custom item';
  const qty = Math.max(1, Math.min(999, parseInt(body.qty, 10) || 1));
  return { key: token(6), product_id: null, barcode: null, name, unit_cents: cents(body.price_cents, 'Price'),
    qty, taxable: body.taxable !== false };
}

app.get('/api/registers/:id/state', ...biz, wrap(async (req, res) => {
  const r = await getRegister(req.params.id, req.user.business_id);
  const pairUrl = `${publicOrigin(req)}/scan#${r.pair_token}`;
  res.json({
    register: { id: r.id, name: r.name, location_id: r.location_id, location_name: r.location_name,
      tax_rate: Number(r.tax_rate) },
    cart: r.cart, totals: computeTotals(r.cart, r.tax_rate),
    pair_url: pairUrl,
    pair_qr_svg: await QRCode.toString(pairUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
  });
}));
app.post('/api/registers/:id/cart/scan', ...biz, wrap(async (req, res) => {
  res.json(await scanIntoCart(req.params.id, req.user.business_id, req.body.code, 'register'));
}));
app.post('/api/registers/:id/cart/product', ...biz, wrap(async (req, res) => {
  res.json(await mutateCart(req.params.id, req.user.business_id, async (cart, client) => {
    const { rows } = await client.query(`SELECT ${PRODUCT_COLS} FROM products WHERE id=$1 AND business_id=$2 AND active`,
      [req.body.product_id, req.user.business_id]);
    if (!rows[0]) fail(404, 'Product not found');
    addProductToCart(cart, rows[0]);
  }, 'register'));
}));
app.post('/api/registers/:id/cart/custom', ...biz, wrap(async (req, res) => {
  const item = customItem(req.body);
  res.json(await mutateCart(req.params.id, req.user.business_id, async (cart) => { cart.push(item); }, 'register'));
}));
app.post('/api/registers/:id/cart/qty', ...biz, wrap(async (req, res) => {
  const qty = parseInt(req.body.qty, 10);
  res.json(await mutateCart(req.params.id, req.user.business_id, async (cart) => {
    const i = cart.findIndex((it) => it.key === req.body.key);
    if (i < 0) fail(404, 'Item is no longer in the cart');
    if (!(qty > 0)) cart.splice(i, 1); else cart[i].qty = Math.min(qty, 999);
  }, 'register'));
}));
app.post('/api/registers/:id/cart/remove', ...biz, wrap(async (req, res) => {
  res.json(await mutateCart(req.params.id, req.user.business_id, async (cart) => {
    const i = cart.findIndex((it) => it.key === req.body.key);
    if (i >= 0) cart.splice(i, 1);
  }, 'register'));
}));
app.post('/api/registers/:id/cart/clear', ...biz, wrap(async (req, res) => {
  res.json(await mutateCart(req.params.id, req.user.business_id, async (cart) => { cart.length = 0; }, 'register'));
}));

// ---------- complete sale ----------
app.post('/api/registers/:id/checkout', ...biz, wrap(async (req, res) => {
  const method = ['cash', 'card', 'other'].includes(req.body.payment_method) ? req.body.payment_method : fail(400, 'Choose a payment method');
  const client = await pool.connect();
  let saleId;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT r.id, r.cart, r.location_id, l.tax_rate FROM registers r JOIN locations l ON l.id = r.location_id
        WHERE r.id = $1 AND l.business_id = $2 FOR UPDATE OF r`, [req.params.id, req.user.business_id]);
    const reg = rows[0] || fail(404, 'Register not found');
    if (!reg.cart.length) fail(400, 'The cart is empty');
    const t = computeTotals(reg.cart, reg.tax_rate);
    let tendered = null, change = null;
    if (method === 'cash') {
      tendered = req.body.tendered_cents == null || req.body.tendered_cents === '' ? t.total_cents : cents(req.body.tendered_cents, 'Cash received');
      if (tendered < t.total_cents) fail(400, 'Cash received is less than the total');
      change = tendered - t.total_cents;
    }
    const s = await client.query(
      `INSERT INTO sales (business_id, location_id, register_id, user_id, subtotal_cents, tax_cents, total_cents,
         tax_rate, payment_method, tendered_cents, change_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.user.business_id, reg.location_id, reg.id, req.user.id, t.subtotal_cents, t.tax_cents, t.total_cents,
        reg.tax_rate, method, tendered, change]);
    saleId = s.rows[0].id;
    for (const it of reg.cart) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, barcode, name, qty, unit_cents, taxable, line_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [saleId, it.product_id, it.barcode, it.name, it.qty, it.unit_cents, it.taxable, it.unit_cents * it.qty]);
      if (it.product_id) {
        await client.query('UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2 AND business_id = $3 AND track_stock',
          [it.qty, it.product_id, req.user.business_id]);
      }
    }
    await client.query(`UPDATE registers SET cart = '[]'::jsonb WHERE id = $1`, [reg.id]);
    await client.query('COMMIT');
    broadcast(reg.id, { type: 'cart', cart: [], totals: computeTotals([], reg.tax_rate), source: 'register',
      event: { kind: 'sale', sale_id: saleId } });
    res.json({ sale_id: saleId, ...t, tendered_cents: tendered, change_cents: change });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// ---------- phone scanner (paired by QR code, no login) ----------
async function registerByPair(t) {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.cart, l.tax_rate, l.name AS location_name, l.business_id, b.name AS business_name,
            b.accent_color
       FROM registers r JOIN locations l ON l.id = r.location_id JOIN businesses b ON b.id = l.business_id
      WHERE r.pair_token = $1 AND r.active AND l.active AND b.active`, [String(t || '')]);
  if (!rows[0]) fail(404, 'This scanner link is no longer valid. Scan the QR code on the register again.');
  return rows[0];
}
const phoneView = (r) => ({ cart: r.cart, totals: r.totals });
app.get('/api/pair/:token', wrap(async (req, res) => {
  const r = await registerByPair(req.params.token);
  res.json({ register_name: r.name, location_name: r.location_name, business_name: r.business_name,
    accent_color: r.accent_color, cart: r.cart, totals: computeTotals(r.cart, r.tax_rate) });
}));
app.post('/api/pair/:token/scan', wrap(async (req, res) => {
  const r = await registerByPair(req.params.token);
  const out = await scanIntoCart(r.id, r.business_id, req.body.code, 'phone');
  res.json({ found: out.found, code: out.code, item: out.item, ...phoneView(out) });
}));
app.post('/api/pair/:token/custom', wrap(async (req, res) => {
  const r = await registerByPair(req.params.token);
  const item = customItem(req.body);
  const out = await mutateCart(r.id, r.business_id, async (cart) => { cart.push(item); return { event: { kind: 'added', name: item.name } }; }, 'phone');
  res.json({ item, ...phoneView(out) });
}));
app.post('/api/pair/:token/remove', wrap(async (req, res) => {
  const r = await registerByPair(req.params.token);
  const out = await mutateCart(r.id, r.business_id, async (cart) => {
    const i = cart.findIndex((it) => it.key === req.body.key);
    if (i >= 0) cart.splice(i, 1);
  }, 'phone');
  res.json(phoneView(out));
}));

// ---------- products ----------
app.get('/api/products', ...biz, wrap(async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const params = [req.user.business_id];
  let where = 'business_id = $1';
  if (req.query.all !== '1') where += ' AND active';
  if (q) { params.push(`%${q}%`); where += ` AND (name ILIKE $2 OR barcode ILIKE $2 OR category ILIKE $2)`; }
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLS} FROM products WHERE ${where} ORDER BY category NULLS LAST, name LIMIT 1000`, params);
  res.json(rows);
}));

// ---------- product photos ----------
async function sendProductImage(res, productId, businessId) {
  const { rows } = await pool.query(
    'SELECT image, image_type FROM products WHERE id = $1 AND business_id = $2 AND image IS NOT NULL',
    [productId, businessId]);
  if (!rows[0]) return res.status(404).end();
  // URLs carry ?v=<version>, so a new photo gets a new URL and the old one can be cached.
  res.set({ 'Content-Type': rows[0].image_type, 'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff' });
  res.send(rows[0].image);
}
app.get('/api/products/:id/image', ...biz, wrap(async (req, res) => {
  await sendProductImage(res, req.params.id, req.user.business_id);
}));
app.get('/api/pair/:token/products/:id/image', wrap(async (req, res) => {
  const r = await registerByPair(req.params.token);
  await sendProductImage(res, req.params.id, r.business_id);
}));
// Body: { data_url: "data:image/jpeg;base64,..." } — the browser shrinks the photo first.
app.put('/api/products/:id/image', ...managers, wrap(async (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data_url || ''));
  if (!m) fail(400, 'Photo must be a JPEG, PNG or WebP image');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 1.5 * 1024 * 1024) fail(400, 'Photo is too large (1.5 MB max)');
  const r = await pool.query(
    'UPDATE products SET image=$1, image_type=$2, image_updated_at=now() WHERE id=$3 AND business_id=$4',
    [bytes, m[1], req.params.id, req.user.business_id]);
  if (!r.rowCount) fail(404, 'Product not found');
  res.json({ ok: true });
}));
app.delete('/api/products/:id/image', ...managers, wrap(async (req, res) => {
  const r = await pool.query(
    'UPDATE products SET image=NULL, image_type=NULL, image_updated_at=NULL WHERE id=$1 AND business_id=$2',
    [req.params.id, req.user.business_id]);
  if (!r.rowCount) fail(404, 'Product not found');
  res.json({ ok: true });
}));
function productFields(body) {
  return [
    text(body.barcode, 'Barcode', { required: false, max: 64 }) || null,
    text(body.name, 'Product name', { max: 150 }),
    text(body.category, 'Category', { required: false, max: 60 }) || null,
    cents(body.price_cents, 'Price'),
    body.taxable !== false,
    !!body.track_stock,
    Math.round(Number(body.stock_qty) || 0),
    body.active !== false,
  ];
}
function duplicateBarcode(e) {
  if (e.code === '23505') throw new HttpError(400, 'Another product already uses that barcode');
  throw e;
}
app.post('/api/products', ...managers, wrap(async (req, res) => {
  const f = productFields(req.body);
  const r = await pool.query(
    `INSERT INTO products (business_id, barcode, name, category, price_cents, taxable, track_stock, stock_qty, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [req.user.business_id, ...f]).catch(duplicateBarcode);
  res.json({ id: r.rows[0].id });
}));
app.put('/api/products/:id', ...managers, wrap(async (req, res) => {
  const f = productFields(req.body);
  const r = await pool.query(
    `UPDATE products SET barcode=$1, name=$2, category=$3, price_cents=$4, taxable=$5, track_stock=$6,
       stock_qty=$7, active=$8 WHERE id=$9 AND business_id=$10`,
    [...f, req.params.id, req.user.business_id]).catch(duplicateBarcode);
  if (!r.rowCount) fail(404, 'Product not found');
  res.json({ ok: true });
}));

// ---------- employees ----------
app.get('/api/users', ...managers, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, active, created_at FROM users WHERE business_id = $1 ORDER BY name`,
    [req.user.business_id]);
  res.json(rows);
}));
function allowedRole(req, role) {
  const mine = req.user.role === 'admin' ? 'owner' : req.user.role;
  const allowed = mine === 'owner' ? ['owner', 'manager', 'cashier'] : ['cashier'];
  if (!allowed.includes(role)) fail(403, 'You cannot give that role');
  return role;
}
app.post('/api/users', ...managers, wrap(async (req, res) => {
  const role = allowedRole(req, req.body.role);
  const password = text(req.body.password, 'Password');
  if (password.length < 8) fail(400, 'Password must be at least 8 characters');
  const r = await pool.query(
    `INSERT INTO users (business_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.user.business_id, text(req.body.name, 'Name'), text(req.body.email, 'Email').toLowerCase(),
      await bcrypt.hash(password, 10), role])
    .catch((e) => { if (e.code === '23505') fail(400, 'That email is already in use'); throw e; });
  res.json({ id: r.rows[0].id });
}));
app.put('/api/users/:id', ...managers, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT role FROM users WHERE id=$1 AND business_id=$2',
    [req.params.id, req.user.business_id]);
  if (!rows[0]) fail(404, 'Employee not found');
  allowedRole(req, rows[0].role);
  const role = allowedRole(req, req.body.role || rows[0].role);
  if (Number(req.params.id) === req.user.id && (req.body.active === false || role !== rows[0].role)) {
    fail(400, 'You cannot change your own role or turn off your own login');
  }
  await pool.query('UPDATE users SET name=$1, role=$2, active=$3 WHERE id=$4',
    [text(req.body.name, 'Name'), role, req.body.active !== false, req.params.id]);
  if (req.body.password) {
    if (String(req.body.password).length < 8) fail(400, 'Password must be at least 8 characters');
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(String(req.body.password), 10), req.params.id]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]);
  }
  if (req.body.active === false) await pool.query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- sales & reports ----------
app.get('/api/sales', ...managers, wrap(async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  const tz = /^[A-Za-z_]+\/[A-Za-z_]+$/.test(req.query.tz || '') ? req.query.tz : 'America/Chicago';
  const params = [req.user.business_id, from || '1970-01-01', to || '2999-12-31', tz];
  let where = `s.business_id = $1 AND (s.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`;
  if (req.query.location_id) { params.push(req.query.location_id); where += ` AND s.location_id = $${params.length}`; }
  const list = await pool.query(
    `SELECT s.id, s.created_at, s.total_cents, s.tax_cents, s.subtotal_cents, s.payment_method, s.voided,
            l.name AS location_name, r.name AS register_name, u.name AS cashier
       FROM sales s JOIN locations l ON l.id = s.location_id
       LEFT JOIN registers r ON r.id = s.register_id LEFT JOIN users u ON u.id = s.user_id
      WHERE ${where} ORDER BY s.created_at DESC LIMIT 500`, params);
  const sum = await pool.query(
    `SELECT s.payment_method, count(*)::int AS n, sum(s.total_cents)::bigint AS total,
            sum(s.tax_cents)::bigint AS tax, sum(s.subtotal_cents)::bigint AS subtotal
       FROM sales s WHERE ${where} AND NOT s.voided GROUP BY s.payment_method`, params);
  res.json({ sales: list.rows, summary: sum.rows.map((r) => ({ ...r, total: Number(r.total), tax: Number(r.tax), subtotal: Number(r.subtotal) })) });
}));
app.get('/api/sales/:id', ...biz, wrap(async (req, res) => {
  const s = await pool.query(
    `SELECT s.*, l.name AS location_name, l.address AS location_address, l.phone AS location_phone,
            b.name AS business_name, b.logo_url, u.name AS cashier, r.name AS register_name
       FROM sales s JOIN locations l ON l.id = s.location_id JOIN businesses b ON b.id = s.business_id
       LEFT JOIN users u ON u.id = s.user_id LEFT JOIN registers r ON r.id = s.register_id
      WHERE s.id = $1 AND s.business_id = $2`, [req.params.id, req.user.business_id]);
  if (!s.rows[0]) fail(404, 'Sale not found');
  const items = await pool.query('SELECT name, barcode, qty, unit_cents, taxable, line_cents FROM sale_items WHERE sale_id = $1 ORDER BY id', [req.params.id]);
  res.json({ ...s.rows[0], items: items.rows });
}));
app.post('/api/sales/:id/void', ...managers, wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query('SELECT voided FROM sales WHERE id=$1 AND business_id=$2 FOR UPDATE',
      [req.params.id, req.user.business_id]);
    if (!s.rows[0]) fail(404, 'Sale not found');
    if (s.rows[0].voided) fail(400, 'Sale is already voided');
    await client.query('UPDATE sales SET voided = TRUE WHERE id = $1', [req.params.id]);
    // Put tracked stock back.
    await client.query(
      `UPDATE products p SET stock_qty = p.stock_qty + si.qty FROM sale_items si
        WHERE si.sale_id = $1 AND si.product_id = p.id AND p.track_stock AND p.business_id = $2`,
      [req.params.id, req.user.business_id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

const PORT = process.env.PORT || 3000;
init().then(() => {
  app.listen(PORT, () => console.log(`MultiPOS running on port ${PORT}`));
}).catch((e) => { console.error('Database setup failed:', e); process.exit(1); });
