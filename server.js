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
app.use((req, res, next) => (/\/(image|pending|approve)$/.test(req.path) ? jsonLarge : jsonSmall)(req, res, next));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Barcode reader engine for the phone page, served from this app (no outside CDN needed).
const vendorDir = (pkg) => path.join(__dirname, 'node_modules', pkg);
app.get('/vendor/barcode-detector.js', (req, res) =>
  res.sendFile(path.join(vendorDir('barcode-detector'), 'dist/iife/pure.js'), { maxAge: '7d' }));
app.get('/vendor/zxing_reader.wasm', (req, res) =>
  res.type('application/wasm').sendFile(path.join(vendorDir('zxing-wasm'), 'dist/reader/zxing_reader.wasm'), { maxAge: '7d' }));

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
    const b = await pool.query('SELECT id, name, accent_color, logo_url, rentals_enabled, half_day_hours, deposit_account FROM businesses WHERE id = $1', [req.user.business_id]);
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
  // Only the fields sent are changed: { active } and/or { rentals_enabled }.
  if ('active' in req.body) await pool.query('UPDATE businesses SET active = $1 WHERE id = $2', [!!req.body.active, req.params.id]);
  if ('rentals_enabled' in req.body) await pool.query('UPDATE businesses SET rentals_enabled = $1 WHERE id = $2', [!!req.body.rentals_enabled, req.params.id]);
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
  if ('deposit_account' in req.body) {
    await pool.query('UPDATE businesses SET deposit_account=$1 WHERE id=$2',
      [text(req.body.deposit_account, 'Bank account', { required: false, max: 120 }) || null, req.user.business_id]);
  }
  if (req.body.half_day_hours != null && req.body.half_day_hours !== '') {
    const h = parseInt(req.body.half_day_hours, 10);
    if (!(h >= 1 && h <= 12)) fail(400, 'Half day must be 1 to 12 hours');
    await pool.query('UPDATE businesses SET half_day_hours=$1 WHERE id=$2', [h, req.user.business_id]);
  }
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
  active, created_at, is_rental, rate_half_day, rate_day, rate_week, rate_month, rental_units, (image IS NOT NULL) AS has_image,
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
    // Rental items are rented with the Rent button (customer + period), not sold by scanning.
    if (rows[0].is_rental) return { found: false, rental: { id: rows[0].id, name: rows[0].name }, code, event: { kind: 'rental', code } };
    const item = addProductToCart(cart, rows[0]);
    return { found: true, item, event: { kind: 'added', name: rows[0].name } };
  }, source);
}
function customItem(body) {
  const name = text(body.name, 'Description', { required: false, max: 120 }) || 'Custom item';
  const qty = Math.max(1, Math.min(999, parseInt(body.qty, 10) || 1));
  const barcode = text(body.barcode, 'Barcode', { required: false, max: 100 }) || null;
  return { key: token(6), product_id: null, barcode, name, unit_cents: cents(body.price_cents, 'Price'),
    qty, taxable: body.taxable !== false };
}
// Turns "data:image/jpeg;base64,..." into bytes, or null if no photo was sent.
function photoFromBody(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) fail(400, 'Photo must be a JPEG, PNG or WebP image');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 1.5 * 1024 * 1024) fail(400, 'Photo is too large (1.5 MB max)');
  return { bytes, type: m[1] };
}

// Records an item that isn't in Products for management, and optionally adds it to the sale.
// The same barcode reported again updates the existing pending entry instead of adding another.
async function reportPending(reg, body, reportedBy, source) {
  const item = customItem(body);
  const note = text(body.note, 'Note', { required: false, max: 300 }) || null;
  const photo = photoFromBody(body.photo);
  let pendingId;
  const existing = item.barcode ? await pool.query(
    `SELECT id FROM pending_items WHERE business_id=$1 AND barcode=$2 AND status='pending' LIMIT 1`,
    [reg.business_id, item.barcode]) : { rows: [] };
  if (existing.rows[0]) {
    pendingId = existing.rows[0].id;
    await pool.query(
      `UPDATE pending_items SET times_seen = times_seen + 1, updated_at = now(), name = $2, price_cents = $3,
         note = COALESCE($4, note), reported_by = $5, location_id = $6, register_id = $7,
         image = COALESCE($8, image), image_type = CASE WHEN $8::bytea IS NULL THEN image_type ELSE $9 END
       WHERE id = $1`,
      [pendingId, item.name, item.unit_cents, note, reportedBy, reg.location_id, reg.id, photo?.bytes || null, photo?.type || null]);
  } else {
    const r = await pool.query(
      `INSERT INTO pending_items (business_id, location_id, register_id, barcode, name, price_cents, note, image, image_type, reported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [reg.business_id, reg.location_id, reg.id, item.barcode, item.name, item.unit_cents, note,
        photo?.bytes || null, photo?.type || null, reportedBy]);
    pendingId = r.rows[0].id;
  }
  let out = {};
  if (body.add_to_sale !== false) {
    out = await mutateCart(reg.id, reg.business_id, async (cart) => {
      cart.push(item); return { event: { kind: 'added', name: item.name } };
    }, source);
  }
  return { pending_id: pendingId, item, ...out };
}

app.get('/api/registers/:id/state', ...biz, wrap(async (req, res) => {
  const r = await getRegister(req.params.id, req.user.business_id);
  const pairUrl = `${publicOrigin(req)}/scan#${r.pair_token}`;
  res.json({
    register: { id: r.id, name: r.name, location_id: r.location_id, location_name: r.location_name,
      tax_rate: Number(r.tax_rate) },
    cart: r.cart, totals: computeTotals(r.cart, r.tax_rate),
    sale_info: await saleInfoView(r.sale_info, req.user.business_id),
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
    if (rows[0].is_rental) fail(400, 'This is a rental item. Use Rent.');
    addProductToCart(cart, rows[0]);
  }, 'register'));
}));
app.post('/api/registers/:id/cart/custom', ...biz, wrap(async (req, res) => {
  const item = customItem(req.body);
  res.json(await mutateCart(req.params.id, req.user.business_id, async (cart) => { cart.push(item); }, 'register'));
}));
app.post('/api/registers/:id/cart/pending', ...biz, wrap(async (req, res) => {
  const reg = await getRegister(req.params.id, req.user.business_id);
  const out = await reportPending(reg, req.body, `${req.user.name} · ${reg.location_name} · ${reg.name}`, 'register');
  res.json({ pending_id: out.pending_id, item: out.item, cart: out.cart, totals: out.totals });
}));
// ---------- rentals: add a prepaid rental to the cart ----------
const PERIODS = { half_day: 'Half day', day: 'Day', week: 'Week', month: 'Month' };
function rentalDue(start, period, count, halfDayHours) {
  const d = new Date(start);
  if (period === 'half_day') d.setHours(d.getHours() + halfDayHours);
  else if (period === 'day') d.setDate(d.getDate() + count);
  else if (period === 'week') d.setDate(d.getDate() + 7 * count);
  else d.setMonth(d.getMonth() + count);
  return d;
}
function periodText(period, count) {
  if (period === 'half_day') return 'Half day';
  const unit = { day: 'day', week: 'week', month: 'month' }[period];
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
async function rentalsOn(businessId) {
  const b = await pool.query('SELECT rentals_enabled, half_day_hours FROM businesses WHERE id=$1', [businessId]);
  if (!b.rows[0] || !b.rows[0].rentals_enabled) fail(403, 'Rentals are not turned on for this business');
  return b.rows[0];
}
// How many units of a rental item are out right now.
async function unitsOut(productId) {
  const r = await pool.query(`SELECT COALESCE(sum(qty),0)::int AS n FROM rentals WHERE product_id=$1 AND status='out'`, [productId]);
  return r.rows[0].n;
}
app.get('/api/rental-items', ...biz, wrap(async (req, res) => {
  const bset = await rentalsOn(req.user.business_id);
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLS}, (SELECT COALESCE(sum(qty),0)::int FROM rentals r WHERE r.product_id = products.id AND r.status='out') AS units_out
       FROM products WHERE business_id=$1 AND is_rental AND active ORDER BY name`, [req.user.business_id]);
  res.json({ items: rows, half_day_hours: bset.half_day_hours });
}));
app.post('/api/registers/:id/cart/rental', ...biz, wrap(async (req, res) => {
  const bset = await rentalsOn(req.user.business_id);
  const period = PERIODS[req.body.period] ? req.body.period : fail(400, 'Choose a rental period');
  const count = period === 'half_day' ? 1 : Math.max(1, Math.min(365, parseInt(req.body.count, 10) || 1));
  const qty = Math.max(1, Math.min(99, parseInt(req.body.qty, 10) || 1));
  const customerName = text(req.body.customer_name, 'Customer name', { max: 100 });
  const customerPhone = text(req.body.customer_phone, 'Customer phone', { max: 40 });
  const p = await pool.query(`SELECT ${PRODUCT_COLS} FROM products WHERE id=$1 AND business_id=$2 AND is_rental AND active`,
    [req.body.product_id, req.user.business_id]);
  const prod = p.rows[0] || fail(404, 'Rental item not found');
  const rate = prod['rate_' + period];
  if (rate == null) fail(400, `${prod.name} has no ${PERIODS[period].toLowerCase()} rate`);
  const available = prod.rental_units - (await unitsOut(prod.id));
  if (qty > available) fail(400, available > 0 ? `Only ${available} available right now` : `All ${prod.name} units are rented out`);
  const now = new Date();
  let due = rentalDue(now, period, count, bset.half_day_hours);
  if (req.body.due_at) {
    const d = new Date(req.body.due_at);
    if (isNaN(d) || d <= now) fail(400, 'Due back time must be in the future');
    due = d;
  }
  const item = {
    key: token(6), product_id: null, barcode: prod.barcode, taxable: prod.taxable, qty,
    name: `Rental: ${prod.name} · ${periodText(period, count)}`,
    unit_cents: rate * count,
    rental: { product_id: prod.id, period, count, due_at: due.toISOString(), customer_name: customerName, customer_phone: customerPhone,
      item_name: prod.name },
    img: prod.image_version ? Number(prod.image_version) : null, rental_product_id: prod.id,
  };
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
// Gift card numbers are printed like "GC-7K3M-9QX2"; typing is forgiving about dashes, spaces and case.
function normalizeGiftCode(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  const core = s.startsWith('GC') ? s.slice(2) : s;
  return core.length === 8 ? `GC-${core.slice(0, 4)}-${core.slice(4)}` : null;
}
function newGiftCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L mix-ups
  let s = '';
  for (const b of crypto.randomBytes(8)) s += chars[b % chars.length];
  return `GC-${s.slice(0, 4)}-${s.slice(4)}`;
}

// Checks the payments add up to the total exactly. Body is either
//   { payments: [{ method, amount_cents, tendered_cents? }, ...] }   (split pay)
// or the older single form { payment_method, tendered_cents? }.
function checkPayments(body, total) {
  let list = Array.isArray(body.payments) ? body.payments
    : [{ method: body.payment_method, amount_cents: total, tendered_cents: body.tendered_cents }];
  if (!list.length) fail(400, 'Add a payment');
  if (list.length > 10) fail(400, 'Too many payments (10 max)');
  list = list.map((p) => {
    const method = ['cash', 'card', 'other', 'gift_card', 'check', 'account'].includes(p.method) ? p.method : fail(400, 'Choose a payment method');
    const checkNumber = method === 'check' ? (text(p.check_number, 'Check number', { required: false, max: 40 }) || null) : null;
    const amount = cents(p.amount_cents, 'Payment amount');
    if (amount <= 0) fail(400, 'Each payment must be more than $0.00');
    const giftCode = method === 'gift_card' ? normalizeGiftCode(p.gift_code) : null;
    if (method === 'gift_card' && !giftCode) fail(400, 'Enter the gift card number');
    let tendered = null, change = null;
    if (method === 'cash') {
      tendered = p.tendered_cents == null || p.tendered_cents === '' ? amount : cents(p.tendered_cents, 'Cash received');
      if (tendered < amount) fail(400, 'Cash received is less than the cash payment');
      change = tendered - amount;
    }
    return { method, amount, tendered, change, giftCode, giftCardId: null, checkNumber };
  });
  const paid = list.reduce((a, p) => a + p.amount, 0);
  if (paid !== total) fail(400, paid < total
    ? `Payments are $${((total - paid) / 100).toFixed(2)} short of the total`
    : `Payments are $${((paid - total) / 100).toFixed(2)} more than the total`);
  return list;
}

app.post('/api/registers/:id/checkout', ...biz, wrap(async (req, res) => {
  const client = await pool.connect();
  let saleId;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT r.id, r.cart, r.sale_info, r.location_id, l.tax_rate FROM registers r JOIN locations l ON l.id = r.location_id
        WHERE r.id = $1 AND l.business_id = $2 FOR UPDATE OF r`, [req.params.id, req.user.business_id]);
    const reg = rows[0] || fail(404, 'Register not found');
    if (!reg.cart.length) fail(400, 'The cart is empty');
    const t = computeTotals(reg.cart, reg.tax_rate);
    const payments = t.total_cents > 0 ? checkPayments(req.body, t.total_cents) : [];
    const info = reg.sale_info || {};
    // Customer on the sale (and charge account rules).
    let cust = null;
    if (info.customer_id) {
      const c = await client.query(`SELECT c.*, ${BALANCE_SQL} AS balance_cents FROM customers c WHERE c.id=$1 AND c.business_id=$2`,
        [info.customer_id, req.user.business_id]);
      cust = c.rows[0] || null;
    }
    const onAccount = payments.filter((p) => p.method === 'account').reduce((a, p) => a + p.amount, 0);
    if (onAccount) {
      if (!cust) fail(400, 'Choose a customer with a charge account first');
      if (!cust.charge_account) fail(400, `${cust.name} does not have a charge account`);
      if (cust.credit_limit_cents != null && cust.balance_cents + onAccount > cust.credit_limit_cents) {
        fail(400, `This would put ${cust.name} over their $${(cust.credit_limit_cents / 100).toFixed(2)} credit limit ` +
          `(balance now $${(cust.balance_cents / 100).toFixed(2)})`);
      }
    }
    const method = payments.length > 1 ? 'split' : (payments[0]?.method
      || (['cash', 'card', 'other'].includes(req.body.payment_method) ? req.body.payment_method : 'cash'));
    const cashParts = payments.filter((p) => p.method === 'cash');
    const tendered = cashParts.length ? cashParts.reduce((a, p) => a + p.tendered, 0) : null;
    const change = cashParts.length ? cashParts.reduce((a, p) => a + p.change, 0) : null;
    const s = await client.query(
      `INSERT INTO sales (business_id, location_id, register_id, user_id, subtotal_cents, tax_cents, total_cents,
         tax_rate, payment_method, tendered_cents, change_cents, receipt_token,
         customer_id, customer_name, customer_phone, po_number, job_address, job_lat, job_lng, quote_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [req.user.business_id, reg.location_id, reg.id, req.user.id, t.subtotal_cents, t.tax_cents, t.total_cents,
        reg.tax_rate, method, tendered, change, token(16),
        cust ? cust.id : null, cust ? cust.name : (info.customer_name || null), cust ? cust.phone : (info.customer_phone || null),
        info.po_number || null, info.job_address || null, info.job_lat ?? null, info.job_lng ?? null, info.quote_id || null]);
    saleId = s.rows[0].id;
    if (info.quote_id) {
      await client.query(`UPDATE quotes SET status='sold', sale_id=$1 WHERE id=$2 AND business_id=$3`,
        [saleId, info.quote_id, req.user.business_id]);
    }
    for (const p of payments) {
      if (p.method === 'gift_card') {
        const g = await client.query('SELECT id, balance_cents FROM gift_cards WHERE business_id=$1 AND code=$2 FOR UPDATE',
          [req.user.business_id, p.giftCode]);
        if (!g.rows[0]) fail(400, `Gift card ${p.giftCode} was not found`);
        if (g.rows[0].balance_cents < p.amount) fail(400, `Gift card ${p.giftCode} only has $${(g.rows[0].balance_cents / 100).toFixed(2)} left`);
        await client.query('UPDATE gift_cards SET balance_cents = balance_cents - $1 WHERE id = $2', [p.amount, g.rows[0].id]);
        p.giftCardId = g.rows[0].id;
      }
      await client.query(
        `INSERT INTO sale_payments (sale_id, method, amount_cents, tendered_cents, change_cents, gift_card_id, check_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [saleId, p.method, p.amount, p.tendered, p.change, p.giftCardId, p.checkNumber]);
    }
    // Prepaid rentals in this sale go on the "Rentals out" list.
    for (const it of reg.cart.filter((x) => x.rental)) {
      const r = it.rental;
      await client.query(
        `INSERT INTO rentals (business_id, location_id, sale_id, product_id, item_name, qty, period, period_count, paid_cents,
           customer_name, customer_phone, due_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [req.user.business_id, reg.location_id, saleId, r.product_id, r.item_name, it.qty, r.period, r.count,
          it.unit_cents * it.qty, r.customer_name, r.customer_phone, r.due_at]);
    }
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
    await client.query(`UPDATE registers SET cart = '[]'::jsonb, sale_info = '{}'::jsonb WHERE id = $1`, [reg.id]);
    await client.query('COMMIT');
    broadcast(reg.id, { type: 'cart', cart: [], totals: computeTotals([], reg.tax_rate), source: 'register',
      event: { kind: 'sale', sale_id: saleId } });
    broadcast(reg.id, { type: 'sale-info', info: {} });
    res.json({ sale_id: saleId, ...t, payment_method: method, tendered_cents: tendered, change_cents: change,
      payments: payments.map((p) => ({ method: p.method, amount_cents: p.amount, tendered_cents: p.tendered, change_cents: p.change,
        check_number: p.checkNumber })) });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// ---------- phone scanner (paired by QR code, no login) ----------
async function registerByPair(t) {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.cart, r.location_id, l.tax_rate, l.name AS location_name, l.business_id, b.name AS business_name,
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
app.post('/api/pair/:token/pending', wrap(async (req, res) => {
  const r = await registerByPair(req.params.token);
  const out = await reportPending(r, req.body, `Phone scanner · ${r.location_name} · ${r.name}`, 'phone');
  res.json({ pending_id: out.pending_id, item: out.item, cart: out.cart, totals: out.totals });
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
const optCents = (v, label) => (v == null || v === '' ? null : cents(v, label));
// Order matches the column lists in PRODUCT_INSERT_COLS below.
function productFields(body) {
  const isRental = !!body.is_rental;
  const rates = [optCents(body.rate_half_day, 'Half day rate'), optCents(body.rate_day, 'Day rate'),
    optCents(body.rate_week, 'Week rate'), optCents(body.rate_month, 'Month rate')];
  if (isRental && rates.every((r) => r == null)) fail(400, 'Enter at least one rental rate');
  return [
    text(body.barcode, 'Barcode', { required: false, max: 64 }) || null,
    text(body.name, 'Product name', { max: 150 }),
    text(body.category, 'Category', { required: false, max: 60 }) || null,
    isRental && (body.price_cents == null || body.price_cents === '') ? 0 : cents(body.price_cents, 'Price'),
    body.taxable !== false,
    !!body.track_stock,
    Math.round(Number(body.stock_qty) || 0),
    body.active !== false,
    isRental, ...rates,
    Math.max(1, Math.min(9999, parseInt(body.rental_units, 10) || 1)),
  ];
}
const PRODUCT_INSERT_COLS = `barcode, name, category, price_cents, taxable, track_stock, stock_qty, active,
  is_rental, rate_half_day, rate_day, rate_week, rate_month, rental_units`;
function duplicateBarcode(e) {
  if (e.code === '23505') throw new HttpError(400, 'Another product already uses that barcode');
  throw e;
}
app.post('/api/products', ...managers, wrap(async (req, res) => {
  const f = productFields(req.body);
  const r = await pool.query(
    `INSERT INTO products (business_id, ${PRODUCT_INSERT_COLS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [req.user.business_id, ...f]).catch(duplicateBarcode);
  res.json({ id: r.rows[0].id });
}));
app.put('/api/products/:id', ...managers, wrap(async (req, res) => {
  const f = productFields(req.body);
  const r = await pool.query(
    `UPDATE products SET barcode=$1, name=$2, category=$3, price_cents=$4, taxable=$5, track_stock=$6,
       stock_qty=$7, active=$8, is_rental=$9, rate_half_day=$10, rate_day=$11, rate_week=$12, rate_month=$13,
       rental_units=$14 WHERE id=$15 AND business_id=$16`,
    [...f, req.params.id, req.user.business_id]).catch(duplicateBarcode);
  if (!r.rowCount) fail(404, 'Product not found');
  res.json({ ok: true });
}));

// ---------- reports ----------
function reportRange(req) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : fail(400, 'Choose a start date');
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : fail(400, 'Choose an end date');
  const tz = /^[A-Za-z_]+\/[A-Za-z_]+$/.test(req.query.tz || '') ? req.query.tz : 'America/Chicago';
  const loc = req.query.location_id ? Number(req.query.location_id) || null : null;
  return { from, to, tz, loc };
}
// Sales tax collected, grouped by day, week, month or year.
app.get('/api/reports/tax', ...managers, wrap(async (req, res) => {
  const { from, to, tz, loc } = reportRange(req);
  const group = ['day', 'week', 'month', 'year'].includes(req.query.group) ? req.query.group : 'day';
  const params = [req.user.business_id, from, to, tz, group];
  let where = `s.business_id = $1 AND NOT s.voided AND (s.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`;
  if (loc) { params.push(loc); where += ` AND s.location_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc($5, s.created_at AT TIME ZONE $4), 'YYYY-MM-DD') AS period,
            count(*)::int AS sales,
            sum(s.subtotal_cents)::bigint AS subtotal,
            sum((SELECT COALESCE(sum(i.line_cents), 0) FROM sale_items i WHERE i.sale_id = s.id AND i.taxable))::bigint AS taxable,
            sum(s.tax_cents)::bigint AS tax,
            sum(s.total_cents)::bigint AS total
       FROM sales s WHERE ${where} GROUP BY 1 ORDER BY 1`, params);
  const out = rows.map((r) => ({ period: r.period, sales: r.sales, subtotal: Number(r.subtotal), taxable: Number(r.taxable),
    nontaxable: Number(r.subtotal) - Number(r.taxable), tax: Number(r.tax), total: Number(r.total) }));
  const sum = (k) => out.reduce((a, r) => a + r[k], 0);
  res.json({ group, rows: out, totals: { sales: sum('sales'), subtotal: sum('subtotal'), taxable: sum('taxable'),
    nontaxable: sum('nontaxable'), tax: sum('tax'), total: sum('total') } });
}));

// All cash and checks taken in (sales + charge account payments), minus cash refunds.
async function moneyRows(businessId, { from, to, tz, loc, undepositedOnly }) {
  const params = [businessId];
  // $2 = from, $3 = to, $4 = time zone (only when filtering by date).
  if (!undepositedOnly) params.push(from, to, tz);
  const dateCond = (col) => (undepositedOnly ? 'TRUE' : `(${col} AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`);
  let locIdx = null;
  if (loc) { params.push(loc); locIdx = params.length; }
  const dep = (col) => (undepositedOnly ? `${col} IS NULL` : 'TRUE');
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT 's:' || p.id AS key, 'sale' AS kind, s.id AS ref_id, p.method, p.amount_cents, p.check_number,
              COALESCE(s.customer_name, '') AS customer, s.created_at, p.deposit_id, s.location_id
         FROM sale_payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.business_id = $1 AND NOT s.voided AND p.method IN ('cash','check') AND ${dateCond('s.created_at')} AND ${dep('p.deposit_id')}
          ${locIdx ? `AND s.location_id = $${locIdx}` : ''}
       UNION ALL
       SELECT 'a:' || a.id, 'account', a.id, a.method, a.amount_cents, a.check_number, c.name, a.created_at, a.deposit_id, a.location_id
         FROM account_payments a JOIN customers c ON c.id = a.customer_id
        WHERE a.business_id = $1 AND NOT a.voided AND a.method IN ('cash','check') AND ${dateCond('a.created_at')} AND ${dep('a.deposit_id')}
          ${locIdx ? `AND a.location_id = $${locIdx}` : ''}
       UNION ALL
       SELECT 'r:' || f.id, 'refund', f.id, 'cash', -f.amount_cents, NULL, COALESCE(f.customer_name, ''), f.created_at, f.deposit_id, f.location_id
         FROM refunds f
        WHERE f.business_id = $1 AND f.method = 'cash' AND ${dateCond('f.created_at')} AND ${dep('f.deposit_id')}
          ${locIdx ? `AND f.location_id = $${locIdx}` : ''}
     ) x ORDER BY created_at`, params);
  return rows;
}
function summarizeMoney(rows) {
  const cashIn = rows.filter((r) => r.method === 'cash' && r.amount_cents > 0);
  const cashSales = cashIn.filter((r) => r.kind === 'sale').reduce((a, r) => a + r.amount_cents, 0);
  const cashAccount = cashIn.filter((r) => r.kind === 'account').reduce((a, r) => a + r.amount_cents, 0);
  const cashRefunds = -rows.filter((r) => r.kind === 'refund').reduce((a, r) => a + r.amount_cents, 0);
  const checks = rows.filter((r) => r.method === 'check');
  return { cash_sales: cashSales, cash_account: cashAccount, cash_refunds: cashRefunds,
    cash_net: cashSales + cashAccount - cashRefunds,
    checks_total: checks.reduce((a, r) => a + r.amount_cents, 0), check_count: checks.length, checks };
}
app.get('/api/reports/money', ...managers, wrap(async (req, res) => {
  const range = reportRange(req);
  const rows = await moneyRows(req.user.business_id, range);
  // Day-by-day totals for the period.
  const days = {};
  const dayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: range.tz });
  for (const r of rows) {
    const d = (days[dayOf(r.created_at)] ||= { day: dayOf(r.created_at), cash: 0, checks: 0, check_count: 0 });
    if (r.method === 'check') { d.checks += r.amount_cents; d.check_count++; } else d.cash += r.amount_cents;
  }
  res.json({ ...summarizeMoney(rows), days: Object.values(days).sort((a, b) => a.day.localeCompare(b.day)) });
}));

// ---------- bank deposits ----------
app.get('/api/deposits/pending', ...managers, wrap(async (req, res) => {
  const loc = req.query.location_id ? Number(req.query.location_id) || null : null;
  const rows = await moneyRows(req.user.business_id, { loc, undepositedOnly: true });
  res.json(summarizeMoney(rows));
}));
app.post('/api/deposits', ...managers, wrap(async (req, res) => {
  const loc = req.body.location_id ? Number(req.body.location_id) || null : null;
  if (loc) {
    const l = await pool.query('SELECT id FROM locations WHERE id=$1 AND business_id=$2', [loc, req.user.business_id]);
    if (!l.rows[0]) fail(404, 'Location not found');
  }
  const rows = await moneyRows(req.user.business_id, { loc, undepositedOnly: true });
  const sum = summarizeMoney(rows);
  const wanted = new Set((Array.isArray(req.body.check_keys) ? req.body.check_keys : []).map(String));
  const checks = sum.checks.filter((c) => wanted.has(c.key));
  const includeCash = req.body.include_cash !== false;
  const cash = includeCash ? (req.body.cash_cents == null || req.body.cash_cents === '' ? Math.max(0, sum.cash_net) : cents(req.body.cash_cents, 'Cash')) : 0;
  if (!checks.length && !cash) fail(400, 'Nothing to deposit');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await client.query(
      `INSERT INTO deposits (business_id, location_id, cash_cents, cash_collected_cents, checks_cents, check_count, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.business_id, loc, cash, includeCash ? sum.cash_net : 0, checks.reduce((a, c) => a + c.amount_cents, 0), checks.length,
        text(req.body.note, 'Note', { required: false, max: 300 }) || null, req.user.id]);
    const id = d.rows[0].id;
    const mark = async (key) => {
      const [kind, rid] = key.split(':');
      const table = { s: 'sale_payments', a: 'account_payments', r: 'refunds' }[kind];
      await client.query(`UPDATE ${table} SET deposit_id = $1 WHERE id = $2 AND deposit_id IS NULL`, [id, Number(rid)]);
    };
    // Cash: everything collected since the last deposit is counted in this one.
    if (includeCash) for (const r of rows.filter((x) => x.method === 'cash')) await mark(r.key);
    for (const c of checks) await mark(c.key);
    await client.query('COMMIT');
    res.json({ id });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
app.get('/api/deposits', ...managers, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.*, l.name AS location_name, u.name AS created_by_name FROM deposits d
       LEFT JOIN locations l ON l.id = d.location_id LEFT JOIN users u ON u.id = d.created_by
      WHERE d.business_id = $1 ORDER BY d.created_at DESC LIMIT 200`, [req.user.business_id]);
  res.json(rows);
}));
app.get('/api/deposits/:id', ...managers, wrap(async (req, res) => {
  const d = await pool.query(
    `SELECT d.*, l.name AS location_name, l.address AS location_address, b.name AS business_name, b.deposit_account,
            u.name AS created_by_name
       FROM deposits d JOIN businesses b ON b.id = d.business_id LEFT JOIN locations l ON l.id = d.location_id
       LEFT JOIN users u ON u.id = d.created_by WHERE d.id = $1 AND d.business_id = $2`, [req.params.id, req.user.business_id]);
  if (!d.rows[0]) fail(404, 'Deposit not found');
  const checks = await pool.query(
    `SELECT p.check_number, p.amount_cents, COALESCE(s.customer_name, '') AS customer, s.created_at
       FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE p.deposit_id = $1 AND p.method = 'check'
     UNION ALL
     SELECT a.check_number, a.amount_cents, c.name, a.created_at
       FROM account_payments a JOIN customers c ON c.id = a.customer_id WHERE a.deposit_id = $1 AND a.method = 'check'
     ORDER BY 4`, [req.params.id]);
  res.json({ ...d.rows[0], checks: checks.rows });
}));

// ---------- customers & charge accounts ----------
// Account balance = charges to the account (on sales not voided) minus payments on the account.
const BALANCE_SQL = `(COALESCE((SELECT sum(p.amount_cents) FROM sale_payments p JOIN sales s ON s.id = p.sale_id
      WHERE s.customer_id = c.id AND p.method = 'account' AND NOT s.voided), 0)
  - COALESCE((SELECT sum(a.amount_cents) FROM account_payments a WHERE a.customer_id = c.id AND NOT a.voided), 0))::int`;
function customerFields(body, canSetAccount, current) {
  const f = {
    name: text(body.name, 'Customer name', { max: 120 }),
    company: text(body.company, 'Company', { required: false, max: 120 }) || null,
    phone: text(body.phone, 'Phone', { required: false, max: 40 }) || null,
    email: text(body.email, 'Email', { required: false, max: 120 }) || null,
    address: text(body.address, 'Address', { required: false, max: 300 }) || null,
    notes: text(body.notes, 'Notes', { required: false, max: 500 }) || null,
  };
  // Only owners/managers can open a charge account or set a credit limit.
  f.charge_account = canSetAccount ? !!body.charge_account : (current ? current.charge_account : false);
  f.credit_limit_cents = canSetAccount ? optCents(body.credit_limit_cents, 'Credit limit') : (current ? current.credit_limit_cents : null);
  f.active = body.active !== false;
  return f;
}
const isManager = (u) => ['admin', 'owner', 'manager'].includes(u.role);
const phoneDigits = (s) => String(s || '').replace(/\D/g, '');

app.get('/api/customers', ...biz, wrap(async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const params = [req.user.business_id];
  let where = 'c.business_id = $1';
  if (req.query.all !== '1') where += ' AND c.active';
  if (req.query.accounts === '1') where += ' AND c.charge_account';
  if (q) {
    params.push(`%${q}%`);
    const digits = phoneDigits(q);
    where += ` AND (c.name ILIKE $2 OR c.company ILIKE $2 OR c.email ILIKE $2`;
    if (digits.length >= 3) { params.push(`%${digits}%`); where += ` OR regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g') LIKE $3`; }
    where += ')';
  }
  const { rows } = await pool.query(
    `SELECT c.*, ${BALANCE_SQL} AS balance_cents FROM customers c WHERE ${where} ORDER BY c.name LIMIT 200`, params);
  res.json(rows);
}));
app.get('/api/customers/:id', ...biz, wrap(async (req, res) => {
  const c = await pool.query(`SELECT c.*, ${BALANCE_SQL} AS balance_cents FROM customers c WHERE c.id=$1 AND c.business_id=$2`,
    [req.params.id, req.user.business_id]);
  if (!c.rows[0]) fail(404, 'Customer not found');
  // Account activity: charges and payments, newest first.
  const act = await pool.query(
    `SELECT * FROM (
       SELECT 'charge' AS kind, s.id AS ref_id, s.created_at, p.amount_cents, s.po_number, s.job_address, NULL AS method,
              NULL AS check_number, s.voided
         FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE s.customer_id = $1 AND p.method = 'account'
       UNION ALL
       SELECT 'payment', a.id, a.created_at, a.amount_cents, NULL, NULL, a.method, a.check_number, a.voided
         FROM account_payments a WHERE a.customer_id = $1
     ) x ORDER BY created_at DESC LIMIT 300`, [req.params.id]);
  const sales = await pool.query(
    `SELECT id, created_at, total_cents, payment_method, po_number, voided FROM sales WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [req.params.id]);
  const quotes = await pool.query(
    `SELECT id, created_at, total_cents, status, po_number FROM quotes WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.params.id]);
  res.json({ ...c.rows[0], activity: act.rows, sales: sales.rows, quotes: quotes.rows });
}));
app.post('/api/customers', ...biz, wrap(async (req, res) => {
  const f = customerFields(req.body, isManager(req.user));
  const r = await pool.query(
    `INSERT INTO customers (business_id, name, company, phone, email, address, notes, charge_account, credit_limit_cents, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [req.user.business_id, f.name, f.company, f.phone, f.email, f.address, f.notes, f.charge_account, f.credit_limit_cents, f.active]);
  res.json({ id: r.rows[0].id });
}));
app.put('/api/customers/:id', ...biz, wrap(async (req, res) => {
  const cur = await pool.query('SELECT * FROM customers WHERE id=$1 AND business_id=$2', [req.params.id, req.user.business_id]);
  if (!cur.rows[0]) fail(404, 'Customer not found');
  const f = customerFields(req.body, isManager(req.user), cur.rows[0]);
  await pool.query(
    `UPDATE customers SET name=$1, company=$2, phone=$3, email=$4, address=$5, notes=$6, charge_account=$7,
       credit_limit_cents=$8, active=$9 WHERE id=$10`,
    [f.name, f.company, f.phone, f.email, f.address, f.notes, f.charge_account, f.credit_limit_cents, f.active, req.params.id]);
  res.json({ ok: true });
}));
// A payment toward a charge account balance (cash, check, card or other).
app.post('/api/customers/:id/payments', ...biz, wrap(async (req, res) => {
  const c = await pool.query('SELECT id FROM customers WHERE id=$1 AND business_id=$2', [req.params.id, req.user.business_id]);
  if (!c.rows[0]) fail(404, 'Customer not found');
  const method = ['cash', 'check', 'card', 'other'].includes(req.body.method) ? req.body.method : fail(400, 'Choose how they paid');
  const amount = cents(req.body.amount_cents, 'Amount');
  if (amount <= 0) fail(400, 'Enter the amount paid');
  let locationId = null;
  if (req.body.location_id) {
    const l = await pool.query('SELECT id FROM locations WHERE id=$1 AND business_id=$2', [req.body.location_id, req.user.business_id]);
    locationId = l.rows[0] ? l.rows[0].id : null;
  }
  const r = await pool.query(
    `INSERT INTO account_payments (business_id, location_id, customer_id, method, amount_cents, check_number, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [req.user.business_id, locationId, req.params.id, method, amount,
      method === 'check' ? (text(req.body.check_number, 'Check number', { required: false, max: 40 }) || null) : null,
      text(req.body.note, 'Note', { required: false, max: 300 }) || null, req.user.id]);
  res.json({ id: r.rows[0].id });
}));
app.post('/api/account-payments/:id/void', ...managers, wrap(async (req, res) => {
  const r = await pool.query(
    `UPDATE account_payments SET voided=TRUE WHERE id=$1 AND business_id=$2 AND NOT voided AND deposit_id IS NULL`,
    [req.params.id, req.user.business_id]);
  if (!r.rowCount) fail(400, 'Payment not found, already voided, or already deposited');
  res.json({ ok: true });
}));

// ---------- sale details on a register (customer, PO, job site) ----------
async function saleInfoView(info, businessId) {
  info = info || {};
  if (!info.customer_id) return info;
  const c = await pool.query(
    `SELECT c.id, c.name, c.company, c.phone, c.address, c.charge_account, c.credit_limit_cents, ${BALANCE_SQL} AS balance_cents
       FROM customers c WHERE c.id=$1 AND c.business_id=$2`, [info.customer_id, businessId]);
  return { ...info, customer: c.rows[0] || null };
}
function parseCoord(v, max) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) fail(400, 'GPS location is not valid');
  return Math.round(n * 1e6) / 1e6;
}
app.put('/api/registers/:id/sale-info', ...biz, wrap(async (req, res) => {
  await getRegister(req.params.id, req.user.business_id);
  const b = req.body;
  let customerId = null;
  if (b.customer_id) {
    const c = await pool.query('SELECT id FROM customers WHERE id=$1 AND business_id=$2', [b.customer_id, req.user.business_id]);
    customerId = c.rows[0] ? c.rows[0].id : fail(404, 'Customer not found');
  }
  const info = {
    customer_id: customerId,
    // Name/phone without a saved customer (e.g. from a quote for a walk-in).
    customer_name: customerId ? null : (text(b.customer_name, 'Customer name', { required: false, max: 120 }) || null),
    customer_phone: customerId ? null : (text(b.customer_phone, 'Customer phone', { required: false, max: 40 }) || null),
    po_number: text(b.po_number, 'PO number', { required: false, max: 60 }) || null,
    job_address: text(b.job_address, 'Job site address', { required: false, max: 300 }) || null,
    job_lat: parseCoord(b.job_lat, 90), job_lng: parseCoord(b.job_lng, 180),
    quote_id: b.quote_id ? Number(b.quote_id) || null : null,
  };
  if ((info.job_lat == null) !== (info.job_lng == null)) fail(400, 'GPS needs both latitude and longitude');
  await pool.query('UPDATE registers SET sale_info=$1 WHERE id=$2', [JSON.stringify(info), req.params.id]);
  const view = await saleInfoView(info, req.user.business_id);
  broadcast(req.params.id, { type: 'sale-info', info: view });
  res.json(view);
}));

// ---------- quotes ----------
// Saves the register's current cart + details as a quote, then clears the register.
app.post('/api/registers/:id/quote', ...biz, wrap(async (req, res) => {
  const reg = await getRegister(req.params.id, req.user.business_id);
  if (!reg.cart.length) fail(400, 'Add items before saving a quote');
  const info = reg.sale_info || {};
  let cust = null;
  if (info.customer_id) cust = (await pool.query('SELECT * FROM customers WHERE id=$1', [info.customer_id])).rows[0] || null;
  const name = cust ? cust.name : text(req.body.customer_name, 'Customer name', { max: 120 });
  const phone = cust && cust.phone ? cust.phone : text(req.body.customer_phone, 'Customer phone', { max: 40 });
  const days = Math.max(1, Math.min(365, parseInt(req.body.valid_days, 10) || 30));
  const t = computeTotals(reg.cart, reg.tax_rate);
  const q = await pool.query(
    `INSERT INTO quotes (business_id, location_id, customer_id, customer_name, customer_phone, po_number, job_address, job_lat, job_lng,
       cart, subtotal_cents, tax_cents, total_cents, tax_rate, note, valid_until, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, (now() + ($16 || ' days')::interval)::date, $17) RETURNING id`,
    [req.user.business_id, reg.location_id, cust ? cust.id : null, name, phone, info.po_number || null, info.job_address || null,
      info.job_lat ?? null, info.job_lng ?? null, JSON.stringify(reg.cart), t.subtotal_cents, t.tax_cents, t.total_cents,
      reg.tax_rate, text(req.body.note, 'Note', { required: false, max: 500 }) || null, String(days), req.user.id]);
  await pool.query(`UPDATE registers SET cart='[]'::jsonb, sale_info='{}'::jsonb WHERE id=$1`, [reg.id]);
  broadcast(reg.id, { type: 'cart', cart: [], totals: computeTotals([], reg.tax_rate), source: 'register' });
  broadcast(reg.id, { type: 'sale-info', info: {} });
  res.json({ quote_id: q.rows[0].id });
}));
app.get('/api/quotes', ...biz, wrap(async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const status = ['open', 'sold', 'canceled'].includes(req.query.status) ? req.query.status : 'open';
  const params = [req.user.business_id, status];
  let where = 'q.business_id = $1 AND q.status = $2';
  if (q) {
    params.push(`%${q}%`);
    const digits = phoneDigits(q);
    where += ` AND (q.customer_name ILIKE $3 OR q.po_number ILIKE $3 OR q.id::text = $${params.length + 1}`;
    params.push(q.replace(/^#/, ''));
    if (digits.length >= 3) { params.push(`%${digits}%`); where += ` OR regexp_replace(COALESCE(q.customer_phone,''), '\\D', '', 'g') LIKE $${params.length}`; }
    where += ')';
  }
  const { rows } = await pool.query(
    `SELECT q.id, q.customer_name, q.customer_phone, q.po_number, q.job_address, q.total_cents, q.status, q.valid_until,
            q.created_at, q.sale_id, (q.valid_until < CURRENT_DATE) AS expired, u.name AS created_by_name,
            jsonb_array_length(q.cart) AS line_count
       FROM quotes q LEFT JOIN users u ON u.id = q.created_by WHERE ${where} ORDER BY q.created_at DESC LIMIT 200`, params);
  res.json(rows);
}));
app.get('/api/quotes/:id', ...biz, wrap(async (req, res) => {
  const q = await pool.query(
    `SELECT q.*, b.name AS business_name, b.logo_url, l.name AS location_name, l.address AS location_address, l.phone AS location_phone,
            u.name AS created_by_name, (q.valid_until < CURRENT_DATE) AS expired
       FROM quotes q JOIN businesses b ON b.id = q.business_id LEFT JOIN locations l ON l.id = q.location_id
       LEFT JOIN users u ON u.id = q.created_by WHERE q.id=$1 AND q.business_id=$2`, [req.params.id, req.user.business_id]);
  if (!q.rows[0]) fail(404, 'Quote not found');
  res.json(q.rows[0]);
}));
// Puts a quote's items and details on a register so it can be rung up at the quoted prices.
app.post('/api/quotes/:id/load', ...biz, wrap(async (req, res) => {
  const q = await pool.query('SELECT * FROM quotes WHERE id=$1 AND business_id=$2', [req.params.id, req.user.business_id]);
  const quote = q.rows[0] || fail(404, 'Quote not found');
  if (quote.status !== 'open') fail(400, `This quote is already ${quote.status === 'sold' ? 'sold' : 'canceled'}`);
  const reg = await getRegister(req.body.register_id, req.user.business_id);
  if (reg.cart.length && !req.body.replace) fail(409, 'The register already has items. Clear the sale first.');
  const bset = (await pool.query('SELECT half_day_hours FROM businesses WHERE id=$1', [req.user.business_id])).rows[0];
  // Rentals start now, so their due-back times are figured again from today.
  const cart = quote.cart.map((it) => {
    const copy = { ...it, key: token(6) };
    if (copy.rental) copy.rental = { ...copy.rental, due_at: rentalDue(new Date(), copy.rental.period, copy.rental.count, bset.half_day_hours).toISOString() };
    return copy;
  });
  const info = { customer_id: quote.customer_id, customer_name: quote.customer_name, customer_phone: quote.customer_phone,
    po_number: quote.po_number, job_address: quote.job_address, job_lat: quote.job_lat, job_lng: quote.job_lng, quote_id: quote.id };
  await pool.query('UPDATE registers SET cart=$1, sale_info=$2 WHERE id=$3', [JSON.stringify(cart), JSON.stringify(info), reg.id]);
  const totals = computeTotals(cart, reg.tax_rate);
  const view = await saleInfoView(info, req.user.business_id);
  broadcast(reg.id, { type: 'cart', cart, totals, source: 'register' });
  broadcast(reg.id, { type: 'sale-info', info: view });
  res.json({ cart, totals, sale_info: view, tax_changed: Number(reg.tax_rate) !== Number(quote.tax_rate) });
}));
app.post('/api/quotes/:id/cancel', ...biz, wrap(async (req, res) => {
  const r = await pool.query(`UPDATE quotes SET status='canceled' WHERE id=$1 AND business_id=$2 AND status='open'`,
    [req.params.id, req.user.business_id]);
  if (!r.rowCount) fail(400, 'Quote not found or not open');
  res.json({ ok: true });
}));

// ---------- rentals out / returns ----------
app.get('/api/rentals', ...biz, wrap(async (req, res) => {
  await rentalsOn(req.user.business_id);
  const status = req.query.status === 'returned' ? 'returned' : 'out';
  const { rows } = await pool.query(
    `SELECT r.*, (r.status = 'out' AND r.due_at < now()) AS overdue, l.name AS location_name, u.name AS returned_by_name,
            (SELECT json_agg(json_build_object('method', f.method, 'amount_cents', f.amount_cents, 'status', f.status))
               FROM refunds f WHERE f.rental_id = r.id) AS refunds
       FROM rentals r LEFT JOIN locations l ON l.id = r.location_id LEFT JOIN users u ON u.id = r.returned_by
      WHERE r.business_id = $1 AND r.status = $2
      ORDER BY ${status === 'out' ? 'r.due_at ASC' : 'r.returned_at DESC'} LIMIT 300`, [req.user.business_id, status]);
  res.json({ rentals: rows, now: new Date().toISOString() });
}));
app.get('/api/rentals/count', ...biz, wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT count(*)::int AS out, count(*) FILTER (WHERE due_at < now())::int AS overdue
       FROM rentals WHERE business_id=$1 AND status='out'`, [req.user.business_id]);
  res.json(r.rows[0]);
}));
// Check a rental back in. Late: optional custom charge goes onto the register's current sale.
// Early: optional refund as cash (from the drawer), a gift card, or a check owed (ledger).
app.post('/api/rentals/:id/return', ...biz, wrap(async (req, res) => {
  await rentalsOn(req.user.business_id);
  const late = optCents(req.body.late_charge_cents, 'Late charge') || 0;
  const refundAmt = optCents(req.body.refund_cents, 'Refund') || 0;
  if (late && refundAmt) fail(400, 'Use either a late charge or a refund, not both');
  const method = refundAmt ? (['cash', 'gift_card', 'check'].includes(req.body.refund_method) ? req.body.refund_method : fail(400, 'Choose how to refund')) : null;
  const note = text(req.body.note, 'Note', { required: false, max: 300 }) || null;
  const address = text(req.body.mailing_address, 'Mailing address', { required: false, max: 300 }) || null;
  if (method === 'check' && !address) fail(400, 'Enter the mailing address for the check');
  let reg = null;
  if (late || method === 'cash') reg = await getRegister(req.body.register_id, req.user.business_id);

  const client = await pool.connect();
  let gift = null, refundId = null, rental;
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM rentals WHERE id=$1 AND business_id=$2 FOR UPDATE', [req.params.id, req.user.business_id]);
    rental = r.rows[0] || fail(404, 'Rental not found');
    if (rental.status !== 'out') fail(400, 'This rental was already checked in');
    if (refundAmt > rental.paid_cents) fail(400, `Refund can't be more than the $${(rental.paid_cents / 100).toFixed(2)} paid`);
    await client.query(
      `UPDATE rentals SET status='returned', returned_at=now(), returned_by=$1, late_charge_cents=$2, refund_cents=$3, return_note=$4 WHERE id=$5`,
      [req.user.id, late || null, refundAmt || null, note, rental.id]);
    if (refundAmt) {
      let giftId = null;
      if (method === 'gift_card') {
        for (let tries = 0; !gift && tries < 5; tries++) {
          const code = newGiftCode();
          const g = await client.query(
            `INSERT INTO gift_cards (business_id, code, initial_cents, balance_cents, customer_name, customer_phone, source, created_by)
             VALUES ($1,$2,$3,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING RETURNING id, code, balance_cents`,
            [req.user.business_id, code, refundAmt, rental.customer_name, rental.customer_phone,
              `Rental refund #${rental.id}`, req.user.id]);
          gift = g.rows[0] || null;
        }
        if (!gift) fail(500, 'Could not create a gift card number, try again');
        giftId = gift.id;
      }
      const f = await client.query(
        `INSERT INTO refunds (business_id, location_id, register_id, rental_id, amount_cents, method, gift_card_id,
           customer_name, customer_phone, mailing_address, note, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [req.user.business_id, reg ? reg.location_id : rental.location_id, reg ? reg.id : null, rental.id, refundAmt, method, giftId,
          rental.customer_name, rental.customer_phone, address, note, method === 'check' ? 'owed' : 'done', req.user.id]);
      refundId = f.rows[0].id;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  let cartOut = {};
  if (late) {
    const p = rental.product_id ? await pool.query('SELECT taxable FROM products WHERE id=$1', [rental.product_id]) : { rows: [] };
    const item = { key: token(6), product_id: null, barcode: null, qty: 1, unit_cents: late,
      taxable: p.rows[0] ? p.rows[0].taxable : true,
      name: `Late charge: ${rental.item_name} (rental #${rental.id})` };
    cartOut = await mutateCart(reg.id, req.user.business_id, async (cart) => { cart.push(item); return { event: { kind: 'added', name: item.name } }; }, 'register');
  }
  res.json({ ok: true, refund_id: refundId, refund_method: method, refund_cents: refundAmt || 0,
    gift_card: gift ? { code: gift.code, balance_cents: gift.balance_cents } : null,
    late_charge_cents: late || 0, cart: cartOut.cart, totals: cartOut.totals });
}));

// ---------- refunds owed (checks to mail) ----------
app.get('/api/refunds', ...managers, wrap(async (req, res) => {
  const status = ['owed', 'paid', 'done'].includes(req.query.status) ? req.query.status : 'owed';
  const { rows } = await pool.query(
    `SELECT f.*, l.name AS location_name, u.name AS created_by_name, pu.name AS paid_by_name, g.code AS gift_code,
            r.item_name AS rental_item
       FROM refunds f LEFT JOIN locations l ON l.id = f.location_id LEFT JOIN users u ON u.id = f.created_by
       LEFT JOIN users pu ON pu.id = f.paid_by LEFT JOIN gift_cards g ON g.id = f.gift_card_id
       LEFT JOIN rentals r ON r.id = f.rental_id
      WHERE f.business_id=$1 AND f.status=$2 ORDER BY f.created_at DESC LIMIT 300`, [req.user.business_id, status]);
  const c = await pool.query(`SELECT count(*)::int AS n, COALESCE(sum(amount_cents),0)::int AS total FROM refunds WHERE business_id=$1 AND status='owed'`,
    [req.user.business_id]);
  res.json({ refunds: rows, owed: c.rows[0] });
}));
app.post('/api/refunds/:id/paid', ...managers, wrap(async (req, res) => {
  const num = text(req.body.check_number, 'Check number', { required: false, max: 40 }) || null;
  const r = await pool.query(
    `UPDATE refunds SET status='paid', check_number=$1, paid_at=now(), paid_by=$2 WHERE id=$3 AND business_id=$4 AND status='owed'`,
    [num, req.user.id, req.params.id, req.user.business_id]);
  if (!r.rowCount) fail(404, 'Refund not found');
  res.json({ ok: true });
}));

// ---------- gift cards ----------
app.get('/api/gift-cards/:code', ...biz, wrap(async (req, res) => {
  const code = normalizeGiftCode(req.params.code) || fail(404, 'Gift card not found');
  const g = await pool.query(
    `SELECT g.code, g.initial_cents, g.balance_cents, g.customer_name, g.created_at, b.name AS business_name
       FROM gift_cards g JOIN businesses b ON b.id = g.business_id WHERE g.business_id=$1 AND g.code=$2`,
    [req.user.business_id, code]);
  if (!g.rows[0]) fail(404, 'Gift card not found');
  res.json(g.rows[0]);
}));

// ---------- pending items (not in Products yet) ----------
app.get('/api/pending', ...managers, wrap(async (req, res) => {
  const status = ['pending', 'approved', 'dismissed'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await pool.query(
    `SELECT p.id, p.barcode, p.name, p.price_cents, p.note, p.reported_by, p.times_seen, p.status, p.product_id,
            p.created_at, p.updated_at, p.resolved_at, (p.image IS NOT NULL) AS has_image,
            floor(extract(epoch FROM p.updated_at))::bigint AS image_version,
            l.name AS location_name, u.name AS resolved_by_name,
            (SELECT pr.name FROM products pr WHERE pr.business_id = p.business_id AND p.barcode IS NOT NULL
               AND pr.barcode = p.barcode LIMIT 1) AS existing_product
       FROM pending_items p LEFT JOIN locations l ON l.id = p.location_id LEFT JOIN users u ON u.id = p.resolved_by
      WHERE p.business_id = $1 AND p.status = $2
      ORDER BY ${status === 'pending' ? 'p.updated_at DESC' : 'p.resolved_at DESC'} LIMIT 300`,
    [req.user.business_id, status]);
  const c = await pool.query(`SELECT count(*)::int AS n FROM pending_items WHERE business_id=$1 AND status='pending'`,
    [req.user.business_id]);
  res.json({ items: rows, pending_count: c.rows[0].n });
}));
app.get('/api/pending/count', ...managers, wrap(async (req, res) => {
  const c = await pool.query(`SELECT count(*)::int AS n FROM pending_items WHERE business_id=$1 AND status='pending'`,
    [req.user.business_id]);
  res.json({ pending_count: c.rows[0].n });
}));
app.get('/api/pending/:id/image', ...managers, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT image, image_type FROM pending_items WHERE id=$1 AND business_id=$2 AND image IS NOT NULL',
    [req.params.id, req.user.business_id]);
  if (!rows[0]) return res.status(404).end();
  res.set({ 'Content-Type': rows[0].image_type, 'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff' });
  res.send(rows[0].image);
}));
// Turns a pending item into a real product with the approved price.
// Body: product fields + photo ("data:..." new photo, "remove", or empty to keep the reported photo).
app.post('/api/pending/:id/approve', ...managers, wrap(async (req, res) => {
  const f = productFields(req.body);
  const newPhoto = req.body.photo && req.body.photo !== 'remove' ? photoFromBody(req.body.photo) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query(`SELECT * FROM pending_items WHERE id=$1 AND business_id=$2 FOR UPDATE`,
      [req.params.id, req.user.business_id]);
    const pend = p.rows[0] || fail(404, 'Pending item not found');
    if (pend.status !== 'pending') fail(400, 'This item was already handled');
    const keepReported = !newPhoto && req.body.photo !== 'remove' && pend.image;
    const img = newPhoto ? newPhoto.bytes : keepReported ? pend.image : null;
    const imgType = newPhoto ? newPhoto.type : keepReported ? pend.image_type : null;
    const r = await client.query(
      `INSERT INTO products (business_id, ${PRODUCT_INSERT_COLS}, image, image_type, image_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, CASE WHEN $16::bytea IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [req.user.business_id, ...f, img, imgType]).catch(duplicateBarcode);
    await client.query(
      `UPDATE pending_items SET status='approved', product_id=$1, resolved_by=$2, resolved_at=now() WHERE id=$3`,
      [r.rows[0].id, req.user.id, pend.id]);
    await client.query('COMMIT');
    res.json({ product_id: r.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));
app.post('/api/pending/:id/dismiss', ...managers, wrap(async (req, res) => {
  const r = await pool.query(
    `UPDATE pending_items SET status='dismissed', resolved_by=$1, resolved_at=now()
      WHERE id=$2 AND business_id=$3 AND status='pending'`, [req.user.id, req.params.id, req.user.business_id]);
  if (!r.rowCount) fail(404, 'Pending item not found');
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
            l.name AS location_name, r.name AS register_name, u.name AS cashier,
            (SELECT json_agg(json_build_object('method', p.method, 'amount_cents', p.amount_cents) ORDER BY p.id)
               FROM sale_payments p WHERE p.sale_id = s.id) AS payments
       FROM sales s JOIN locations l ON l.id = s.location_id
       LEFT JOIN registers r ON r.id = s.register_id LEFT JOIN users u ON u.id = s.user_id
      WHERE ${where} ORDER BY s.created_at DESC LIMIT 500`, params);
  const tot = await pool.query(
    `SELECT count(*)::int AS n, COALESCE(sum(s.total_cents),0)::bigint AS total, COALESCE(sum(s.tax_cents),0)::bigint AS tax
       FROM sales s WHERE ${where} AND NOT s.voided`, params);
  // Money by payment type comes from the individual payments, so split sales count in each type.
  const sum = await pool.query(
    `SELECT p.method AS payment_method, count(DISTINCT s.id)::int AS n, sum(p.amount_cents)::bigint AS total
       FROM sales s JOIN sale_payments p ON p.sale_id = s.id
      WHERE ${where} AND NOT s.voided GROUP BY p.method`, params);
  // Rental refunds in the same period (cash ones come out of the drawer).
  const rp = [req.user.business_id, params[1], params[2], params[3]];
  let rwhere = `f.business_id = $1 AND (f.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`;
  if (req.query.location_id) { rp.push(req.query.location_id); rwhere += ` AND f.location_id = $${rp.length}`; }
  const ref = await pool.query(
    `SELECT f.method, count(*)::int AS n, sum(f.amount_cents)::bigint AS total FROM refunds f WHERE ${rwhere} GROUP BY f.method`, rp);
  res.json({ sales: list.rows,
    refunds: ref.rows.map((r) => ({ ...r, total: Number(r.total) })),
    totals: { n: tot.rows[0].n, total: Number(tot.rows[0].total), tax: Number(tot.rows[0].tax) },
    summary: sum.rows.map((r) => ({ ...r, total: Number(r.total) })) });
}));
const SALE_SELECT = `SELECT s.*, l.name AS location_name, l.address AS location_address, l.phone AS location_phone,
            b.name AS business_name, b.logo_url, u.name AS cashier, r.name AS register_name
       FROM sales s JOIN locations l ON l.id = s.location_id JOIN businesses b ON b.id = s.business_id
       LEFT JOIN users u ON u.id = s.user_id LEFT JOIN registers r ON r.id = s.register_id`;
async function saleWithItems(sale) {
  const items = await pool.query('SELECT name, barcode, qty, unit_cents, taxable, line_cents FROM sale_items WHERE sale_id = $1 ORDER BY id', [sale.id]);
  const pays = await pool.query('SELECT method, amount_cents, tendered_cents, change_cents, check_number FROM sale_payments WHERE sale_id = $1 ORDER BY id', [sale.id]);
  const rents = await pool.query('SELECT id, item_name, qty, due_at, customer_name FROM rentals WHERE sale_id = $1 ORDER BY id', [sale.id]);
  return { ...sale, items: items.rows, payments: pays.rows, rentals: rents.rows };
}
app.get('/api/sales/:id', ...biz, wrap(async (req, res) => {
  const s = await pool.query(`${SALE_SELECT} WHERE s.id = $1 AND s.business_id = $2`, [req.params.id, req.user.business_id]);
  if (!s.rows[0]) fail(404, 'Sale not found');
  const sale = await saleWithItems(s.rows[0]);
  delete sale.receipt_token;
  res.json(sale);
}));
// Everything needed to send a receipt by WhatsApp: the sale plus its private receipt link.
app.post('/api/sales/:id/share', ...biz, wrap(async (req, res) => {
  // Older sales (before this feature) get a link the first time they're shared.
  await pool.query('UPDATE sales SET receipt_token = $1 WHERE id = $2 AND business_id = $3 AND receipt_token IS NULL',
    [token(16), req.params.id, req.user.business_id]);
  const s = await pool.query(`${SALE_SELECT} WHERE s.id = $1 AND s.business_id = $2`, [req.params.id, req.user.business_id]);
  if (!s.rows[0]) fail(404, 'Sale not found');
  const sale = await saleWithItems(s.rows[0]);
  const url = `${publicOrigin(req)}/r#${sale.receipt_token}`;
  delete sale.receipt_token;
  res.json({ sale, url });
}));
// Public receipt view for customers (only reachable with the private link).
app.get('/api/receipt/:token', wrap(async (req, res) => {
  const t = String(req.params.token || '');
  if (!/^[0-9a-f]{32}$/.test(t)) fail(404, 'Receipt not found');
  const s = await pool.query(`${SALE_SELECT} WHERE s.receipt_token = $1`, [t]);
  if (!s.rows[0]) fail(404, 'Receipt not found');
  const sale = await saleWithItems(s.rows[0]);
  const keep = ['id', 'created_at', 'subtotal_cents', 'tax_cents', 'total_cents', 'tax_rate', 'payment_method',
    'tendered_cents', 'change_cents', 'voided', 'location_name', 'location_address', 'location_phone',
    'business_name', 'logo_url', 'items', 'payments', 'rentals', 'customer_name', 'po_number', 'job_address', 'job_lat', 'job_lng'];
  const out = Object.fromEntries(keep.map((k) => [k, sale[k]]));
  out.cashier = sale.cashier ? sale.cashier.split(' ')[0] : null; // first name only
  res.set('Cache-Control', 'no-store');
  res.json(out);
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
    // Gift card money spent on this sale goes back on the card.
    await client.query(
      `UPDATE gift_cards g SET balance_cents = g.balance_cents + p.amount_cents FROM sale_payments p
        WHERE p.sale_id = $1 AND p.gift_card_id = g.id`, [req.params.id]);
    // Rentals from this sale come off the "out" list.
    await client.query(
      `UPDATE rentals SET status='returned', returned_at=now(), returned_by=$2, return_note='Sale voided'
        WHERE sale_id = $1 AND status = 'out'`, [req.params.id, req.user.id]);
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
