// QuickBooks Online sync for MultiPOS.
// Each business connects its own QuickBooks company. Once a day per location, MultiPOS posts ONE journal
// entry summarizing that day (sales by type, sales tax, how it was paid, account payments, refunds).
// Each MultiPOS bank deposit becomes a QuickBooks Bank Deposit, so it matches the bank statement line.
//
// Server settings (Render > Environment):
//   QBO_CLIENT_ID, QBO_CLIENT_SECRET   from developer.intuit.com > your app > Keys
//   QBO_ENVIRONMENT                    "sandbox" (default) or "production"
//   QBO_REDIRECT_URI                   optional; defaults to <this site>/api/qbo/callback
const crypto = require('crypto');

const ENV = (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
const URLS = {
  auth: process.env.QBO_AUTH_URL || 'https://appcenter.intuit.com/connect/oauth2',
  token: process.env.QBO_TOKEN_URL || 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revoke: process.env.QBO_REVOKE_URL || 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
  api: process.env.QBO_API_BASE || (ENV === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com'),
};
const MINOR = '75';
const configured = () => !!(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET);

// What each QuickBooks account is used for. "make" = the account MultiPOS can create for you.
const ROLES = [
  { key: 'sales_income', label: 'Product sales', types: ['Income'], make: { Name: 'MultiPOS Sales', AccountType: 'Income', AccountSubType: 'SalesOfProductIncome' } },
  { key: 'rental_income', label: 'Rental income (rentals & late charges)', types: ['Income'], make: { Name: 'MultiPOS Rental Income', AccountType: 'Income', AccountSubType: 'OtherPrimaryIncome' } },
  { key: 'fee_income', label: 'Delivery & fuel charges', types: ['Income'], make: { Name: 'MultiPOS Delivery & Fuel Income', AccountType: 'Income', AccountSubType: 'OtherPrimaryIncome' } },
  { key: 'refunds', label: 'Refunds given', types: ['Income', 'Expense'], make: { Name: 'MultiPOS Refunds', AccountType: 'Income', AccountSubType: 'DiscountsRefundsGiven' } },
  { key: 'sales_tax', label: 'Sales tax collected (owed to the state)', types: ['Other Current Liability'], make: { Name: 'MultiPOS Sales Tax Collected', AccountType: 'Other Current Liability', AccountSubType: 'OtherCurrentLiabilities' } },
  { key: 'cash_checks', label: 'Cash & checks waiting to be deposited', types: ['Other Current Asset', 'Bank'], make: { Name: 'MultiPOS Cash & Checks Clearing', AccountType: 'Other Current Asset', AccountSubType: 'OtherCurrentAssets' } },
  { key: 'card_clearing', label: 'Card payments (until the processor deposits them)', types: ['Other Current Asset', 'Bank'], make: { Name: 'MultiPOS Card Clearing', AccountType: 'Other Current Asset', AccountSubType: 'OtherCurrentAssets' } },
  { key: 'other_clearing', label: '"Other" payments', types: ['Other Current Asset', 'Bank'], make: { Name: 'MultiPOS Other Payments Clearing', AccountType: 'Other Current Asset', AccountSubType: 'OtherCurrentAssets' } },
  { key: 'gift_cards', label: 'Gift cards outstanding', types: ['Other Current Liability'], make: { Name: 'MultiPOS Gift Cards Outstanding', AccountType: 'Other Current Liability', AccountSubType: 'OtherCurrentLiabilities' } },
  { key: 'charge_accounts', label: 'Charge accounts (owed by customers)', types: ['Other Current Asset'], make: { Name: 'MultiPOS Charge Accounts', AccountType: 'Other Current Asset', AccountSubType: 'OtherCurrentAssets' } },
  { key: 'refunds_payable', label: 'Refund checks owed to customers', types: ['Other Current Liability'], make: { Name: 'MultiPOS Refund Checks Owed', AccountType: 'Other Current Liability', AccountSubType: 'OtherCurrentLiabilities' } },
  { key: 'deposit_bank', label: 'Bank account deposits go into', types: ['Bank'] },
];

module.exports = function setupQbo(app, { pool, wrap, fail, text, requireLogin, requireBusiness, requireRole, requireAdmin, publicOrigin }) {
  // ---------- token encryption (tokens are stored encrypted) ----------
  const key = () => crypto.createHash('sha256').update('multipos-qbo:' + (process.env.QBO_TOKEN_KEY || process.env.QBO_CLIENT_SECRET || '')).digest();
  function enc(s) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const body = Buffer.concat([c.update(String(s), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  }
  function dec(s) {
    const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }
  // Signed "state" so the QuickBooks callback can't be forged.
  const sign = (s) => crypto.createHmac('sha256', key()).update(s).digest('base64url');
  const redirectUri = (req) => process.env.QBO_REDIRECT_URI || `${publicOrigin(req)}/api/qbo/callback`;

  // ---------- talking to Intuit ----------
  class QboError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }
  async function tokenRequest(params) {
    const r = await fetch(URLS.token, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new QboError(`QuickBooks sign-in failed: ${data.error_description || data.error || r.status}`, r.status, data.error);
    return data;
  }
  async function saveTokens(businessId, t) {
    await pool.query(
      `UPDATE qbo_connections SET access_token_enc=$1, refresh_token_enc=$2,
         access_expires_at = now() + ($3 || ' seconds')::interval,
         refresh_expires_at = now() + ($4 || ' seconds')::interval WHERE business_id=$5`,
      [enc(t.access_token), enc(t.refresh_token), String(t.expires_in || 3600), String(t.x_refresh_token_expires_in || 8640000), businessId]);
  }
  const refreshing = new Map(); // one refresh at a time per business
  async function accessToken(conn, force) {
    if (!force && new Date(conn.access_expires_at) - Date.now() > 5 * 60 * 1000) return dec(conn.access_token_enc);
    if (refreshing.has(conn.business_id)) return refreshing.get(conn.business_id);
    const p = (async () => {
      const fresh = (await pool.query('SELECT * FROM qbo_connections WHERE business_id=$1', [conn.business_id])).rows[0];
      if (!force && fresh && new Date(fresh.access_expires_at) - Date.now() > 5 * 60 * 1000) return dec(fresh.access_token_enc);
      let t;
      try { t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: dec(fresh.refresh_token_enc) }); }
      catch (e) {
        if (e.code === 'invalid_grant') throw new QboError('QuickBooks connection expired. Please connect to QuickBooks again.', 401, 'reconnect');
        throw e;
      }
      await saveTokens(conn.business_id, t);
      Object.assign(conn, (await pool.query('SELECT * FROM qbo_connections WHERE business_id=$1', [conn.business_id])).rows[0]);
      return t.access_token;
    })().finally(() => refreshing.delete(conn.business_id));
    refreshing.set(conn.business_id, p);
    return p;
  }
  async function qbo(conn, method, path, body, retried) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${URLS.api}/v3/company/${conn.realm_id}/${path}${sep}minorversion=${MINOR}`, {
      method,
      headers: { Authorization: 'Bearer ' + await accessToken(conn, retried === 'force'), Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && !retried) return qbo(conn, method, path, body, 'force');
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.Fault) {
      const e = (data.Fault && data.Fault.Error && data.Fault.Error[0]) || {};
      throw new QboError(`QuickBooks: ${e.Message || 'request failed'}${e.Detail ? ' (' + e.Detail + ')' : ''}`, r.status, e.code);
    }
    return data;
  }
  const query = async (conn, q) => (await qbo(conn, 'GET', 'query?query=' + encodeURIComponent(q))).QueryResponse || {};

  async function getConn(businessId) {
    return (await pool.query('SELECT * FROM qbo_connections WHERE business_id=$1', [businessId])).rows[0] || null;
  }
  async function businessSettings(businessId) {
    return (await pool.query('SELECT qbo_enabled, time_zone, name FROM businesses WHERE id=$1', [businessId])).rows[0];
  }

  // ---------- building a day's summary ----------
  const isRental = (n) => /^(Rental: |Late charge: )/.test(n);
  const isFee = (n) => /^(Delivery fee|Fuel charge)/.test(n);
  const dollars = (c) => Math.round(c) / 100;
  // Totals for one location and one day, in cents, by what they mean.
  async function dayTotals(businessId, locationId, day, tz) {
    const p = [businessId, locationId, day, tz];
    const dayCond = (col) => `(${col} AT TIME ZONE $4)::date = $3::date`;
    const items = await pool.query(
      `SELECT i.name, i.line_cents FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.business_id=$1 AND s.location_id=$2 AND NOT s.voided AND ${dayCond('s.created_at')}`, p);
    const sales = await pool.query(
      `SELECT count(*)::int AS n, COALESCE(sum(tax_cents),0)::bigint AS tax, COALESCE(sum(total_cents),0)::bigint AS total
         FROM sales s WHERE s.business_id=$1 AND s.location_id=$2 AND NOT s.voided AND ${dayCond('s.created_at')}`, p);
    const pays = await pool.query(
      `SELECT p.method, sum(p.amount_cents)::bigint AS amt FROM sale_payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.business_id=$1 AND s.location_id=$2 AND NOT s.voided AND ${dayCond('s.created_at')} GROUP BY p.method`, p);
    const acct = await pool.query(
      `SELECT method, sum(amount_cents)::bigint AS amt FROM account_payments a
        WHERE a.business_id=$1 AND a.location_id=$2 AND NOT a.voided AND ${dayCond('a.created_at')} GROUP BY method`, p);
    const refunds = await pool.query(
      `SELECT method, sum(amount_cents)::bigint AS amt FROM refunds f
        WHERE f.business_id=$1 AND f.location_id=$2 AND ${dayCond('f.created_at')} GROUP BY method`, p);
    const t = { sales_count: sales.rows[0].n, products: 0, rentals: 0, fees: 0, tax: Number(sales.rows[0].tax), total: Number(sales.rows[0].total),
      pay: {}, acct: {}, refunds: {} };
    for (const it of items.rows) {
      if (isRental(it.name)) t.rentals += it.line_cents; else if (isFee(it.name)) t.fees += it.line_cents; else t.products += it.line_cents;
    }
    for (const r of pays.rows) t.pay[r.method] = Number(r.amt);
    for (const r of acct.rows) t.acct[r.method] = Number(r.amt);
    for (const r of refunds.rows) t.refunds[r.method] = Number(r.amt);
    return t;
  }
  // Turns the totals into balanced journal entry lines (debits = credits).
  function journalLines(t, map) {
    const lines = [];
    const add = (posting, role, cents, desc) => { if (cents > 0) lines.push({ posting, account: map[role], cents, desc }); };
    // Money in from sales, by how it was paid ...
    const clearing = { cash: 'cash_checks', check: 'cash_checks', card: 'card_clearing', other: 'other_clearing', gift_card: 'gift_cards', account: 'charge_accounts' };
    const payDesc = { cash: 'Cash sales', check: 'Check sales', card: 'Card sales', other: 'Other payments', gift_card: 'Paid with gift cards', account: 'Charged to customer accounts' };
    for (const [m, c] of Object.entries(t.pay)) add('Debit', clearing[m], c, payDesc[m]);
    // ... balanced by what was sold and the tax collected.
    add('Credit', 'sales_income', t.products, `Product sales (${t.sales_count} sales)`);
    add('Credit', 'rental_income', t.rentals, 'Rentals and late charges');
    add('Credit', 'fee_income', t.fees, 'Delivery and fuel charges');
    add('Credit', 'sales_tax', t.tax, 'Sales tax collected');
    // Payments customers made on their charge accounts.
    const acctTotal = Object.values(t.acct).reduce((a, c) => a + c, 0);
    for (const [m, c] of Object.entries(t.acct)) add('Debit', clearing[m] || 'other_clearing', c, `Charge account payments (${m})`);
    add('Credit', 'charge_accounts', acctTotal, 'Charge account payments received');
    // Rental refunds: cash from the drawer, gift cards, or checks owed.
    const refTotal = Object.values(t.refunds).reduce((a, c) => a + c, 0);
    add('Debit', 'refunds', refTotal, 'Rental refunds');
    add('Credit', 'cash_checks', t.refunds.cash || 0, 'Cash refunds from the drawer');
    add('Credit', 'gift_cards', t.refunds.gift_card || 0, 'Refunds given as gift cards');
    add('Credit', 'refunds_payable', t.refunds.check || 0, 'Refund checks owed');
    // Combine lines that land on the same account and side.
    const merged = new Map();
    for (const l of lines) {
      const k = l.posting + ':' + l.account;
      if (merged.has(k)) { const m = merged.get(k); m.cents += l.cents; m.desc += '; ' + l.desc; } else merged.set(k, { ...l });
    }
    const out = [...merged.values()];
    const dr = out.filter((l) => l.posting === 'Debit').reduce((a, l) => a + l.cents, 0);
    const cr = out.filter((l) => l.posting === 'Credit').reduce((a, l) => a + l.cents, 0);
    if (dr !== cr) throw new QboError(`Day does not balance (debits ${dr} vs credits ${cr}); not sent`, 400, 'unbalanced');
    return { lines: out, total: dr };
  }
  function jePayload(day, locationName, locationId, built) {
    return {
      TxnDate: day,
      DocNumber: `MP${locationId}-${day.replace(/-/g, '')}`.slice(0, 21),
      PrivateNote: `MultiPOS daily summary · ${locationName} · ${day}. Created automatically; changes made in MultiPOS update it.`,
      Line: built.lines.map((l) => ({
        Description: l.desc.slice(0, 4000), Amount: dollars(l.cents), DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: l.posting, AccountRef: { value: String(l.account) } },
      })),
    };
  }
  const hashOf = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

  const REQUIRED = ROLES.map((r) => r.key);
  const mappingDone = (m) => REQUIRED.every((k) => m && m[k]);

  // ---------- the sync ----------
  const running = new Set();
  async function syncBusiness(businessId, { maxItems = 120 } = {}) {
    if (running.has(businessId)) return { skipped: 'A sync is already running' };
    running.add(businessId);
    const result = { days_sent: 0, days_updated: 0, days_removed: 0, deposits_sent: 0, unchanged: 0, errors: [] };
    try {
      const conn = await getConn(businessId);
      const biz = await businessSettings(businessId);
      if (!conn || !biz || !biz.qbo_enabled) return { skipped: 'QuickBooks is not connected' };
      if (!mappingDone(conn.mapping) || !conn.sync_from) return { skipped: 'Finish the QuickBooks setup (accounts and start date) first' };
      const tz = biz.time_zone || 'America/Chicago';
      const map = conn.mapping;
      const locs = Object.fromEntries((await pool.query('SELECT id, name FROM locations WHERE business_id=$1', [businessId])).rows.map((l) => [l.id, l.name]));
      // Every day (up to yesterday) and location with any activity, plus days sent before (in case everything was voided).
      const days = await pool.query(
        `SELECT DISTINCT day::text, location_id FROM (
           SELECT (created_at AT TIME ZONE $2)::date AS day, location_id FROM sales WHERE business_id=$1
           UNION SELECT (created_at AT TIME ZONE $2)::date, location_id FROM account_payments WHERE business_id=$1 AND location_id IS NOT NULL
           UNION SELECT (created_at AT TIME ZONE $2)::date, location_id FROM refunds WHERE business_id=$1 AND location_id IS NOT NULL
           UNION SELECT day, location_id FROM qbo_syncs WHERE business_id=$1 AND realm_id=$4 AND kind='day'
         ) x WHERE day >= $3::date AND day < (now() AT TIME ZONE $2)::date ORDER BY 1, 2`, [businessId, tz, conn.sync_from, conn.realm_id]);
      let done = 0;
      for (const { day, location_id: loc } of days.rows) {
        if (done >= maxItems) break;
        const ref = `${loc}:${day}`;
        const prev = (await pool.query(`SELECT * FROM qbo_syncs WHERE business_id=$1 AND realm_id=$2 AND kind='day' AND ref=$3`,
          [businessId, conn.realm_id, ref])).rows[0];
        try {
          const totals = await dayTotals(businessId, loc, day, tz);
          const built = journalLines(totals, map);
          const payload = built.lines.length ? jePayload(day, locs[loc] || 'Location ' + loc, loc, built) : null;
          const hash = payload ? hashOf(payload) : 'empty';
          if (prev && prev.status === 'ok' && prev.payload_hash === hash) { result.unchanged++; continue; }
          done++;
          let saved = null;
          if (!payload) {
            // Everything that day was voided: remove the entry from QuickBooks.
            if (prev && prev.qbo_id) {
              await withSyncToken(conn, 'journalentry', prev, (st) => qbo(conn, 'POST', 'journalentry?operation=delete', { Id: prev.qbo_id, SyncToken: st }));
              result.days_removed++;
            }
            await pool.query(`DELETE FROM qbo_syncs WHERE id=$1`, [prev ? prev.id : -1]);
            continue;
          }
          if (prev && prev.qbo_id) {
            saved = (await withSyncToken(conn, 'journalentry', prev, (st) =>
              qbo(conn, 'POST', 'journalentry', { ...payload, Id: prev.qbo_id, SyncToken: st, sparse: false }))).JournalEntry;
            result.days_updated++;
          } else {
            // In case an earlier attempt reached QuickBooks but the result wasn't saved here.
            const found = (await query(conn, `select Id, SyncToken from JournalEntry where DocNumber = '${payload.DocNumber}'`)).JournalEntry;
            saved = found && found[0]
              ? (await qbo(conn, 'POST', 'journalentry', { ...payload, Id: found[0].Id, SyncToken: found[0].SyncToken, sparse: false })).JournalEntry
              : (await qbo(conn, 'POST', 'journalentry', payload)).JournalEntry;
            result.days_sent++;
          }
          await pool.query(
            `INSERT INTO qbo_syncs (business_id, realm_id, kind, ref, location_id, day, qbo_type, qbo_id, sync_token, amount_cents, payload_hash, status, error, synced_at)
             VALUES ($1,$2,'day',$3,$4,$5,'JournalEntry',$6,$7,$8,$9,'ok',NULL,now())
             ON CONFLICT (business_id, realm_id, kind, ref) DO UPDATE SET qbo_id=EXCLUDED.qbo_id, sync_token=EXCLUDED.sync_token,
               amount_cents=EXCLUDED.amount_cents, payload_hash=EXCLUDED.payload_hash, status='ok', error=NULL, synced_at=now()`,
            [businessId, conn.realm_id, ref, loc, day, saved.Id, saved.SyncToken, built.total, hash]);
        } catch (e) {
          if (e.code === 'reconnect') throw e;
          result.errors.push(`${day} ${locs[loc] || ''}: ${e.message}`);
          await recordError(businessId, conn.realm_id, 'day', ref, { location_id: loc, day }, e.message);
        }
      }
      // Bank deposits made in MultiPOS (never changed after they're made).
      const deps = await pool.query(
        `SELECT d.* FROM deposits d WHERE d.business_id=$1 AND (d.created_at AT TIME ZONE $2)::date >= $3::date
            AND NOT EXISTS (SELECT 1 FROM qbo_syncs q WHERE q.business_id=$1 AND q.realm_id=$4 AND q.kind='deposit' AND q.ref = d.id::text AND q.status='ok')
          ORDER BY d.id`, [businessId, tz, conn.sync_from, conn.realm_id]);
      for (const d of deps.rows) {
        if (done >= maxItems) break;
        done++;
        try {
          const checks = await pool.query(
            `SELECT p.check_number, p.amount_cents, COALESCE(s.customer_name,'') AS who FROM sale_payments p JOIN sales s ON s.id=p.sale_id
              WHERE p.deposit_id=$1 AND p.method='check'
             UNION ALL SELECT a.check_number, a.amount_cents, c.name FROM account_payments a JOIN customers c ON c.id=a.customer_id
              WHERE a.deposit_id=$1 AND a.method='check'`, [d.id]);
          const line = (cents, desc, checkNum) => ({ Amount: dollars(cents), Description: desc.slice(0, 4000), DetailType: 'DepositLineDetail',
            DepositLineDetail: { AccountRef: { value: String(map.cash_checks) }, ...(checkNum ? { CheckNum: String(checkNum).slice(0, 21) } : {}) } });
          const lines = [];
          if (d.cash_cents > 0) lines.push(line(d.cash_cents, 'Cash'));
          for (const c of checks.rows) lines.push(line(c.amount_cents, `Check${c.check_number ? ' #' + c.check_number : ''}${c.who ? ' from ' + c.who : ''}`, c.check_number));
          if (!lines.length) continue;
          const day = new Date(d.created_at).toLocaleDateString('en-CA', { timeZone: tz });
          const saved = (await qbo(conn, 'POST', 'deposit', {
            TxnDate: day, DepositToAccountRef: { value: String(map.deposit_bank) },
            PrivateNote: `MultiPOS deposit #${d.id}${d.location_id && locs[d.location_id] ? ' · ' + locs[d.location_id] : ''}${d.note ? ' · ' + d.note : ''}`,
            Line: lines,
          })).Deposit;
          await pool.query(
            `INSERT INTO qbo_syncs (business_id, realm_id, kind, ref, location_id, day, deposit_id, qbo_type, qbo_id, sync_token, amount_cents, status, error, synced_at)
             VALUES ($1,$2,'deposit',$3,$4,$5,$6,'Deposit',$7,$8,$9,'ok',NULL,now())
             ON CONFLICT (business_id, realm_id, kind, ref) DO UPDATE SET qbo_id=EXCLUDED.qbo_id, sync_token=EXCLUDED.sync_token,
               amount_cents=EXCLUDED.amount_cents, status='ok', error=NULL, synced_at=now()`,
            [businessId, conn.realm_id, String(d.id), d.location_id, day, d.id, saved.Id, saved.SyncToken, d.cash_cents + d.checks_cents]);
          result.deposits_sent++;
        } catch (e) {
          if (e.code === 'reconnect') throw e;
          result.errors.push(`Deposit #${d.id}: ${e.message}`);
          await recordError(businessId, conn.realm_id, 'deposit', String(d.id), { location_id: d.location_id, deposit_id: d.id }, e.message);
        }
      }
      await pool.query('UPDATE qbo_connections SET last_sync_at=now(), last_sync_error=$1 WHERE business_id=$2',
        [result.errors.length ? result.errors.slice(0, 3).join(' | ') : null, businessId]);
      return result;
    } catch (e) {
      await pool.query('UPDATE qbo_connections SET last_sync_at=now(), last_sync_error=$1 WHERE business_id=$2', [e.message, businessId]);
      result.errors.push(e.message);
      return result;
    } finally { running.delete(businessId); }
  }
  // Updates need QuickBooks' current version number; if someone edited it in QuickBooks, fetch the new one and retry.
  async function withSyncToken(conn, entity, prev, fn) {
    try { return await fn(prev.sync_token); }
    catch (e) {
      if (!/stale|syncToken|5010/i.test(e.message + e.code)) throw e;
      const cur = await qbo(conn, 'GET', `${entity}/${prev.qbo_id}`);
      const obj = cur.JournalEntry || cur.Deposit;
      return fn(obj.SyncToken);
    }
  }
  async function recordError(businessId, realm, kind, ref, extra, msg) {
    await pool.query(
      `INSERT INTO qbo_syncs (business_id, realm_id, kind, ref, location_id, day, deposit_id, status, error, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'error',$8,now())
       ON CONFLICT (business_id, realm_id, kind, ref) DO UPDATE SET status='error', error=EXCLUDED.error, synced_at=now()`,
      [businessId, realm, kind, ref, extra.location_id || null, extra.day || null, extra.deposit_id || null, String(msg).slice(0, 500)]);
  }

  // ---------- routes (owners only) ----------
  const owner = [requireLogin, requireBusiness, requireRole('owner')];
  const needConfigured = (req, res, next) => (configured() ? next() : next(Object.assign(new Error('QuickBooks is not set up on this server yet (QBO_CLIENT_ID / QBO_CLIENT_SECRET).'), { status: 400 })));
  const needEnabled = wrap(async (req, res, next) => {
    const b = await businessSettings(req.user.business_id);
    if (!b.qbo_enabled) fail(403, 'QuickBooks is not turned on for this business');
    next();
  });

  app.get('/api/qbo/status', ...owner, wrap(async (req, res) => {
    const b = await businessSettings(req.user.business_id);
    const conn = await getConn(req.user.business_id);
    const out = { configured: configured(), enabled: b.qbo_enabled, environment: ENV, time_zone: b.time_zone,
      roles: ROLES.map(({ key: k, label, types, make }) => ({ key: k, label, types, can_create: !!make })) };
    if (conn) {
      Object.assign(out, { connected: true, company_name: conn.company_name, realm_id: conn.realm_id, connected_env: conn.environment,
        mapping: conn.mapping, sync_from: conn.sync_from, last_sync_at: conn.last_sync_at, last_sync_error: conn.last_sync_error,
        setup_done: mappingDone(conn.mapping) && !!conn.sync_from });
      const log = await pool.query(
        `SELECT q.kind, q.ref, q.day, q.deposit_id, q.qbo_id, q.amount_cents, q.status, q.error, q.synced_at, l.name AS location_name
           FROM qbo_syncs q LEFT JOIN locations l ON l.id = q.location_id
          WHERE q.business_id=$1 AND q.realm_id=$2 ORDER BY q.synced_at DESC LIMIT 60`, [req.user.business_id, conn.realm_id]);
      out.log = log.rows;
    }
    res.json(out);
  }));

  // Step 1: send the owner to Intuit to sign in and pick their QuickBooks company.
  app.get('/api/qbo/connect', ...owner, needConfigured, needEnabled, wrap(async (req, res) => {
    const st = Buffer.from(JSON.stringify({ b: req.user.business_id, u: req.user.id, t: Date.now(), n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
    const state = st + '.' + sign(st);
    const url = `${URLS.auth}?` + new URLSearchParams({ client_id: process.env.QBO_CLIENT_ID, response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting', redirect_uri: redirectUri(req), state }).toString();
    res.json({ url });
  }));
  // Step 2: Intuit sends them back here with a one-time code.
  app.get('/api/qbo/callback', requireLogin, wrap(async (req, res) => {
    const back = (msg) => res.redirect('/admin#quickbooks' + (msg ? '?qbo=' + encodeURIComponent(msg) : ''));
    if (req.query.error) return back(req.query.error === 'access_denied' ? 'You canceled the QuickBooks connection.' : 'QuickBooks said: ' + req.query.error);
    const [st, sig] = String(req.query.state || '').split('.');
    if (!st || !sig || sign(st) !== sig) return back('That QuickBooks link was not valid. Try again.');
    const s = JSON.parse(Buffer.from(st, 'base64url').toString());
    if (Date.now() - s.t > 30 * 60 * 1000) return back('That QuickBooks link expired. Try again.');
    if (s.u !== req.user.id || s.b !== req.user.business_id) return back('Please connect from the business you are logged into.');
    const realm = String(req.query.realmId || '');
    if (!/^\d+$/.test(realm) || !req.query.code) return back('QuickBooks did not send back a company.');
    try {
      const t = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(req) });
      const prev = await getConn(s.b);
      await pool.query(
        `INSERT INTO qbo_connections (business_id, realm_id, environment, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, connected_by,
           mapping, sync_from)
         VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval, now() + ($7 || ' seconds')::interval, $8, $9, $10)
         ON CONFLICT (business_id) DO UPDATE SET realm_id=EXCLUDED.realm_id, environment=EXCLUDED.environment,
           access_token_enc=EXCLUDED.access_token_enc, refresh_token_enc=EXCLUDED.refresh_token_enc, access_expires_at=EXCLUDED.access_expires_at,
           refresh_expires_at=EXCLUDED.refresh_expires_at, connected_by=EXCLUDED.connected_by, connected_at=now(),
           mapping=EXCLUDED.mapping, sync_from=EXCLUDED.sync_from, last_sync_error=NULL`,
        [s.b, realm, ENV, enc(t.access_token), enc(t.refresh_token), String(t.expires_in || 3600), String(t.x_refresh_token_expires_in || 8640000), s.u,
          // Same QuickBooks company as before: keep the account setup. Different company: start fresh.
          JSON.stringify(prev && prev.realm_id === realm ? prev.mapping : {}), prev && prev.realm_id === realm ? prev.sync_from : null]);
      const conn = await getConn(s.b);
      try {
        const info = await qbo(conn, 'GET', `companyinfo/${realm}`);
        await pool.query('UPDATE qbo_connections SET company_name=$1 WHERE business_id=$2', [info.CompanyInfo && info.CompanyInfo.CompanyName, s.b]);
      } catch (e) { /* name is optional */ }
      back('');
    } catch (e) { back(e.message); }
  }));
  app.post('/api/qbo/disconnect', ...owner, wrap(async (req, res) => {
    const conn = await getConn(req.user.business_id);
    if (conn && configured()) {
      try {
        await fetch(URLS.revoke, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64'),
          'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ token: dec(conn.refresh_token_enc) }) });
      } catch (e) { /* disconnect anyway */ }
    }
    // The sync history is kept, so reconnecting the same company won't send days twice.
    await pool.query('DELETE FROM qbo_connections WHERE business_id=$1', [req.user.business_id]);
    res.json({ ok: true });
  }));

  // QuickBooks accounts to choose from in setup.
  app.get('/api/qbo/accounts', ...owner, needConfigured, wrap(async (req, res) => {
    const conn = (await getConn(req.user.business_id)) || fail(400, 'Connect to QuickBooks first');
    const r = await query(conn, 'select Id, Name, FullyQualifiedName, AccountType, AccountSubType, Active from Account where Active = true maxresults 1000');
    res.json((r.Account || []).map((a) => ({ id: a.Id, name: a.FullyQualifiedName || a.Name, type: a.AccountType, subtype: a.AccountSubType }))
      .sort((a, b) => a.name.localeCompare(b.name)));
  }));
  // Creates the recommended "MultiPOS ..." accounts in QuickBooks (or finds them if they exist) and fills in the setup.
  app.post('/api/qbo/accounts/recommended', ...owner, needConfigured, wrap(async (req, res) => {
    const conn = (await getConn(req.user.business_id)) || fail(400, 'Connect to QuickBooks first');
    const existing = (await query(conn, 'select Id, Name, AccountType from Account maxresults 1000')).Account || [];
    const mapping = { ...(conn.mapping || {}) };
    const made = [];
    for (const role of ROLES.filter((r) => r.make)) {
      if (mapping[role.key] && !req.body.overwrite) continue;
      let acc = existing.find((a) => a.Name === role.make.Name);
      if (!acc) { acc = (await qbo(conn, 'POST', 'account', role.make)).Account; made.push(role.make.Name); }
      mapping[role.key] = acc.Id;
    }
    // Pick the bank account if there's only one.
    if (!mapping.deposit_bank) {
      const banks = existing.filter((a) => a.AccountType === 'Bank');
      if (banks.length === 1) mapping.deposit_bank = banks[0].Id;
    }
    await pool.query('UPDATE qbo_connections SET mapping=$1 WHERE business_id=$2', [JSON.stringify(mapping), req.user.business_id]);
    res.json({ mapping, created: made });
  }));
  app.put('/api/qbo/settings', ...owner, wrap(async (req, res) => {
    const conn = (await getConn(req.user.business_id)) || fail(400, 'Connect to QuickBooks first');
    const mapping = {};
    for (const r of ROLES) {
      const v = req.body.mapping && req.body.mapping[r.key];
      if (v != null && v !== '') { if (!/^\d+$/.test(String(v))) fail(400, 'Account choice is not valid'); mapping[r.key] = String(v); }
    }
    const from = req.body.sync_from;
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) fail(400, 'Start date is not valid');
    await pool.query('UPDATE qbo_connections SET mapping=$1, sync_from=$2 WHERE business_id=$3', [JSON.stringify(mapping), from || null, req.user.business_id]);
    if (req.body.time_zone && /^[A-Za-z_]+\/[A-Za-z_]+$/.test(req.body.time_zone)) {
      await pool.query('UPDATE businesses SET time_zone=$1 WHERE id=$2', [req.body.time_zone, req.user.business_id]);
    }
    res.json({ ok: true, setup_done: mappingDone(mapping) && !!from });
  }));
  // What a day's summary would look like (nothing is sent).
  app.get('/api/qbo/preview', ...owner, wrap(async (req, res) => {
    const conn = (await getConn(req.user.business_id)) || fail(400, 'Connect to QuickBooks first');
    const b = await businessSettings(req.user.business_id);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : fail(400, 'Choose a day');
    const locs = (await pool.query('SELECT id, name FROM locations WHERE business_id=$1 ORDER BY name', [req.user.business_id])).rows;
    const names = {};
    try {
      const accts = (await query(conn, 'select Id, Name, FullyQualifiedName from Account maxresults 1000')).Account || [];
      for (const a of accts) names[a.Id] = a.FullyQualifiedName || a.Name;
    } catch (e) { /* show ids only */ }
    const out = [];
    for (const l of locs) {
      const t = await dayTotals(req.user.business_id, l.id, day, b.time_zone);
      let built; try { built = journalLines(t, conn.mapping || {}); } catch (e) { out.push({ location: l.name, error: e.message }); continue; }
      if (!built.lines.length) continue;
      out.push({ location: l.name, total_cents: built.total,
        lines: built.lines.map((x) => ({ posting: x.posting, account: names[x.account] || (x.account ? 'Account #' + x.account : '(not chosen yet)'), cents: x.cents, desc: x.desc })) });
    }
    res.json({ day, entries: out });
  }));
  app.post('/api/qbo/sync', ...owner, needConfigured, needEnabled, wrap(async (req, res) => {
    res.json(await syncBusiness(req.user.business_id));
  }));
  // Platform admin switch for the add-on.
  app.put('/api/admin/businesses/:id/qbo', requireLogin, requireAdmin, wrap(async (req, res) => {
    await pool.query('UPDATE businesses SET qbo_enabled=$1 WHERE id=$2', [!!req.body.enabled, req.params.id]);
    res.json({ ok: true });
  }));

  // ---------- automatic sync every hour ----------
  async function syncAll() {
    if (!configured()) return;
    const { rows } = await pool.query(
      `SELECT c.business_id FROM qbo_connections c JOIN businesses b ON b.id=c.business_id WHERE b.qbo_enabled AND b.active AND c.sync_from IS NOT NULL`);
    for (const r of rows) {
      try { await syncBusiness(r.business_id); } catch (e) { console.error('QuickBooks sync failed for business', r.business_id, e.message); }
    }
  }
  if (!process.env.QBO_NO_AUTO_SYNC) {
    setTimeout(() => { syncAll(); setInterval(syncAll, 60 * 60 * 1000); }, 90 * 1000);
  }
  return { syncBusiness, journalLines, dayTotals };
};
