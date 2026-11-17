// Database connection and schema. Tables are created automatically on startup.
const { Pool, types } = require('pg');
// Keep plain dates (like a quote's "valid until") as "2026-11-26" instead of a time-zone-shifted timestamp.
types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it in Render > Environment.');
  process.exit(1);
}

const useSSL = !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) && process.env.PGSSLMODE !== 'disable';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

const schema = `
CREATE TABLE IF NOT EXISTS businesses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  accent_color TEXT NOT NULL DEFAULT '#1f8f4e',
  logo_url TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  tax_rate NUMERIC(6,3) NOT NULL DEFAULT 8.25,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registers (
  id SERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pair_token TEXT NOT NULL UNIQUE,
  cart JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- role: admin (platform owner), owner, manager, cashier
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','owner','manager','cashier')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acting_business_id INT REFERENCES businesses(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  barcode TEXT,
  name TEXT NOT NULL,
  category TEXT,
  price_cents INT NOT NULL CHECK (price_cents >= 0),
  taxable BOOLEAN NOT NULL DEFAULT TRUE,
  track_stock BOOLEAN NOT NULL DEFAULT FALSE,
  stock_qty INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Product photos are stored small (resized in the browser) inside the database,
-- because Render's server disk is wiped on every deploy.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image BYTEA;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_type TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_updated_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS products_business_barcode
  ON products(business_id, barcode) WHERE barcode IS NOT NULL AND barcode <> '';

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id INT NOT NULL REFERENCES locations(id),
  register_id INT REFERENCES registers(id) ON DELETE SET NULL,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  subtotal_cents INT NOT NULL,
  tax_cents INT NOT NULL,
  total_cents INT NOT NULL,
  tax_rate NUMERIC(6,3) NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','card','other')),
  tendered_cents INT,
  change_cents INT,
  voided BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_business_date ON sales(business_id, created_at);
-- Private, unguessable link so a customer can view their receipt without logging in.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sales_receipt_token ON sales(receipt_token) WHERE receipt_token IS NOT NULL;

-- Split pay: each sale has one or more payments (cash + card, etc.).
-- (The allowed payment types for sales/sale_payments are set once, further down.)
CREATE TABLE IF NOT EXISTS sale_payments (
  id SERIAL PRIMARY KEY,
  sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('cash','card','other')),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  tendered_cents INT,
  change_cents INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sale_payments_sale ON sale_payments(sale_id);
-- Sales made before split pay existed get their single payment recorded once.
INSERT INTO sale_payments (sale_id, method, amount_cents, tendered_cents, change_cents)
  SELECT s.id, s.payment_method, s.total_cents, s.tendered_cents, s.change_cents FROM sales s
   WHERE s.payment_method <> 'split' AND s.total_cents > 0
     AND NOT EXISTS (SELECT 1 FROM sale_payments p WHERE p.sale_id = s.id);

-- ===== Rentals add-on (switched on per business by the platform admin) =====
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS rentals_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS half_day_hours INT NOT NULL DEFAULT 4;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_rental BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS rate_half_day INT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS rate_day INT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS rate_week INT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS rate_month INT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS rental_units INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS rentals (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id INT REFERENCES locations(id) ON DELETE SET NULL,
  sale_id INT REFERENCES sales(id) ON DELETE SET NULL,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  period TEXT NOT NULL CHECK (period IN ('half_day','day','week','month')),
  period_count INT NOT NULL DEFAULT 1,
  paid_cents INT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  start_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'out' CHECK (status IN ('out','returned')),
  returned_at TIMESTAMPTZ,
  returned_by INT REFERENCES users(id) ON DELETE SET NULL,
  late_charge_cents INT,
  refund_cents INT,
  return_note TEXT
);
CREATE INDEX IF NOT EXISTS rentals_business ON rentals(business_id, status, due_at);

-- Gift cards (used for rental refunds, and spendable at checkout).
CREATE TABLE IF NOT EXISTS gift_cards (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  initial_cents INT NOT NULL,
  balance_cents INT NOT NULL CHECK (balance_cents >= 0),
  customer_name TEXT,
  customer_phone TEXT,
  source TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS gift_card_id INT REFERENCES gift_cards(id) ON DELETE SET NULL;

-- Money given back to customers (early rental returns): cash from the drawer, a gift card,
-- or "check" = owed, kept on a ledger until the store mails a check.
CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id INT REFERENCES locations(id) ON DELETE SET NULL,
  register_id INT REFERENCES registers(id) ON DELETE SET NULL,
  rental_id INT REFERENCES rentals(id) ON DELETE SET NULL,
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','gift_card','check')),
  gift_card_id INT REFERENCES gift_cards(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  mailing_address TEXT,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('done','owed','paid')),
  check_number TEXT,
  paid_at TIMESTAMPTZ,
  paid_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refunds_business ON refunds(business_id, status, created_at);

-- ===== Customers, charge accounts, quotes, checks, deposits =====
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  charge_account BOOLEAN NOT NULL DEFAULT FALSE,
  credit_limit_cents INT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_business ON customers(business_id, name);

-- What's being entered for the current sale on a register (customer, PO, job site).
ALTER TABLE registers ADD COLUMN IF NOT EXISTS sale_info JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INT REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS po_number TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS job_address TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS job_lat NUMERIC(9,6);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS job_lng NUMERIC(9,6);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS quote_id INT;

-- Deposits made to the bank (cash + checks).
CREATE TABLE IF NOT EXISTS deposits (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id INT REFERENCES locations(id) ON DELETE SET NULL,
  cash_cents INT NOT NULL DEFAULT 0,
  cash_collected_cents INT NOT NULL DEFAULT 0,
  checks_cents INT NOT NULL DEFAULT 0,
  check_count INT NOT NULL DEFAULT 0,
  note TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sale_payments DROP CONSTRAINT IF EXISTS sale_payments_method_check;
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_method_check CHECK (method IN ('cash','card','other','gift_card','check','account'));
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS check_number TEXT;
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS deposit_id INT REFERENCES deposits(id) ON DELETE SET NULL;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check CHECK (payment_method IN ('cash','card','other','split','gift_card','check','account'));
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS deposit_id INT REFERENCES deposits(id) ON DELETE SET NULL;

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS deposit_account TEXT;

-- Payments a customer makes toward their charge account balance.
CREATE TABLE IF NOT EXISTS account_payments (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id INT REFERENCES locations(id) ON DELETE SET NULL,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('cash','check','card','other')),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  check_number TEXT,
  note TEXT,
  voided BOOLEAN NOT NULL DEFAULT FALSE,
  deposit_id INT REFERENCES deposits(id) ON DELETE SET NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_payments_customer ON account_payments(customer_id);

-- Saved price quotes (the cart, customer and job details), found later by phone number.
CREATE TABLE IF NOT EXISTS quotes (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id INT REFERENCES locations(id) ON DELETE SET NULL,
  customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  po_number TEXT,
  job_address TEXT,
  job_lat NUMERIC(9,6),
  job_lng NUMERIC(9,6),
  cart JSONB NOT NULL,
  subtotal_cents INT NOT NULL,
  tax_cents INT NOT NULL,
  total_cents INT NOT NULL,
  tax_rate NUMERIC(6,3) NOT NULL,
  note TEXT,
  valid_until DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','sold','canceled')),
  sale_id INT REFERENCES sales(id) ON DELETE SET NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quotes_business ON quotes(business_id, status, created_at);

ALTER TABLE locations ADD COLUMN IF NOT EXISTS hours JSONB;

-- ===== Pickup/delivery and invoice notes =====
ALTER TABLE sales ADD COLUMN IF NOT EXISTS fulfillment TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_note TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS fulfillment TEXT;

-- ===== Email receipts =====
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS receipt_reply_email TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_emailed_to TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_emailed_at TIMESTAMPTZ;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_email_count INT NOT NULL DEFAULT 0;

-- ===== QuickBooks Online (add-on, switched on per business by the platform admin) =====
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS qbo_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'America/Chicago';
CREATE TABLE IF NOT EXISTS qbo_connections (
  business_id INT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  realm_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  company_name TEXT,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ,
  mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_from DATE,
  last_sync_at TIMESTAMPTZ,
  last_sync_error TEXT,
  connected_by INT REFERENCES users(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One row per thing sent to QuickBooks (a day's summary for a location, or a deposit).
CREATE TABLE IF NOT EXISTS qbo_syncs (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  realm_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('day','deposit')),
  ref TEXT NOT NULL,
  location_id INT,
  day DATE,
  deposit_id INT,
  qbo_type TEXT,
  qbo_id TEXT,
  sync_token TEXT,
  amount_cents INT,
  payload_hash TEXT,
  status TEXT NOT NULL,
  error TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, realm_id, kind, ref)
);

-- Items scanned at the register that aren't in Products yet, waiting for management.
CREATE TABLE IF NOT EXISTS pending_items (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id INT REFERENCES locations(id) ON DELETE SET NULL,
  register_id INT REFERENCES registers(id) ON DELETE SET NULL,
  barcode TEXT,
  name TEXT NOT NULL,
  price_cents INT,
  note TEXT,
  image BYTEA,
  image_type TEXT,
  reported_by TEXT,
  times_seen INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed')),
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  resolved_by INT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_items_business ON pending_items(business_id, status);

CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  barcode TEXT,
  name TEXT NOT NULL,
  qty INT NOT NULL,
  unit_cents INT NOT NULL,
  taxable BOOLEAN NOT NULL,
  line_cents INT NOT NULL
);

-- ===== Job board (always on in ContractorPOS) =====
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS jobs_enabled BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE businesses SET jobs_enabled = TRUE WHERE NOT jobs_enabled;

-- The board's columns (phases). Each company sets its own names, colors and card buttons.
-- buttons: [{ "label": "Ready", "enabled": true, "action": "mark" | "next" }]  (up to 3)
CREATE TABLE IF NOT EXISTS job_columns (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2563c9',
  position INT NOT NULL,
  buttons JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_columns_business ON job_columns(business_id, position);

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id INT REFERENCES locations(id) ON DELETE SET NULL,
  job_number INT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  job_address TEXT,
  po_number TEXT,
  column_id INT REFERENCES job_columns(id) ON DELETE SET NULL,
  status_label TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  crew TEXT,
  start_date DATE,
  column_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tax_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  progress INT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  quoted_cents INT NOT NULL DEFAULT 0 CHECK (quoted_cents >= 0),
  tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
  discount_cents INT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  discount_note TEXT,
  closed_at TIMESTAMPTZ,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, job_number)
);
CREATE INDEX IF NOT EXISTS jobs_business ON jobs(business_id, column_id);

-- Everything added to a job after the quote: inventory items, extra charges (up-charges), equipment rental.
CREATE TABLE IF NOT EXISTS job_items (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('item','charge','rental')),
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  barcode TEXT,
  name TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0),
  unit_cents INT NOT NULL CHECK (unit_cents >= 0),
  taxable BOOLEAN NOT NULL DEFAULT FALSE,
  stock_taken BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_items_job ON job_items(job_id);

-- Payments toward a job (many over the life of the project; each can be split across methods).
CREATE TABLE IF NOT EXISTS job_payments (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id INT REFERENCES locations(id) ON DELETE SET NULL,
  batch TEXT,
  method TEXT NOT NULL CHECK (method IN ('cash','card','check','other')),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  tendered_cents INT,
  change_cents INT,
  check_number TEXT,
  note TEXT,
  voided BOOLEAN NOT NULL DEFAULT FALSE,
  deposit_id INT REFERENCES deposits(id) ON DELETE SET NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_payments_job ON job_payments(job_id);
CREATE INDEX IF NOT EXISTS job_payments_business ON job_payments(business_id, created_at);

-- Everything that happens to a job (moves, button presses, items, payments).
CREATE TABLE IF NOT EXISTS job_history (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_history_job ON job_history(job_id, created_at);

-- Files on a job: PDFs (plans, blueprints, specs), photos, and materials estimates made by Claude from them.
-- Stored in the database because Render's server disk is wiped on every deploy.
CREATE TABLE IF NOT EXISTS job_files (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pdf','photo','estimate')),
  name TEXT NOT NULL,
  mime TEXT,
  data BYTEA,
  size_bytes INT NOT NULL DEFAULT 0,
  estimate JSONB,
  source_file_id INT REFERENCES job_files(id) ON DELETE SET NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_files_job ON job_files(job_id, created_at);

-- Crews working on a job (plumber, dirt work, electrician ...), per phase (board column).
-- billing: 'included' = part of the quoted price (no change to the total);
--          'extra'    = up-charge; it gets a linked "charge" line on the job ticket, so it adds to the total.
CREATE TABLE IF NOT EXISTS job_crews (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  column_id INT REFERENCES job_columns(id) ON DELETE SET NULL,
  trade TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  amount_cents INT NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  billing TEXT NOT NULL DEFAULT 'included' CHECK (billing IN ('included','extra')),
  note TEXT,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_crews_job ON job_crews(job_id);
ALTER TABLE job_items ADD COLUMN IF NOT EXISTS crew_id INT REFERENCES job_crews(id) ON DELETE CASCADE;
-- Cost plus: amount_cents is the crew's cost; the ticket is charged cost + markup (a percent or a dollar amount).
ALTER TABLE job_crews ADD COLUMN IF NOT EXISTS markup_type TEXT;
ALTER TABLE job_crews ADD COLUMN IF NOT EXISTS markup_percent NUMERIC(7,3);
ALTER TABLE job_crews ADD COLUMN IF NOT EXISTS markup_cents INT;
ALTER TABLE job_crews ADD COLUMN IF NOT EXISTS charge_cents INT NOT NULL DEFAULT 0;
ALTER TABLE job_crews DROP CONSTRAINT IF EXISTS job_crews_billing_check;
ALTER TABLE job_crews ADD CONSTRAINT job_crews_billing_check CHECK (billing IN ('included','extra','costplus'));
UPDATE job_crews SET charge_cents = amount_cents WHERE billing = 'extra' AND charge_cents = 0;

-- Column colors chosen by the company (empty = the standard dark look): header lettering, column background, cards, card lettering.
ALTER TABLE job_columns ADD COLUMN IF NOT EXISTS text_color TEXT;
ALTER TABLE job_columns ADD COLUMN IF NOT EXISTS bg_color TEXT;
ALTER TABLE job_columns ADD COLUMN IF NOT EXISTS card_color TEXT;
ALTER TABLE job_columns ADD COLUMN IF NOT EXISTS card_text_color TEXT;

-- Sending a job's quote/statement to the customer: a private link (/j#<token>) and email tracking.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS share_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_share_token ON jobs(share_token) WHERE share_token IS NOT NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS statement_emailed_to TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS statement_email_count INT NOT NULL DEFAULT 0;

-- Claude add-on: switched on per business by the platform admin. Every request is logged (for usage and billing).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS claude_requests (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  job_id INT REFERENCES jobs(id) ON DELETE SET NULL,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  input_tokens INT,
  output_tokens INT,
  ok BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claude_requests_business ON claude_requests(business_id, created_at);
-- 'answer' = Claude's answers to questions about a plan or photo (a saved conversation).
ALTER TABLE job_files DROP CONSTRAINT IF EXISTS job_files_kind_check;
ALTER TABLE job_files ADD CONSTRAINT job_files_kind_check CHECK (kind IN ('pdf','photo','estimate','answer'));
`;

async function init() {
  await pool.query(schema);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
}

module.exports = { pool, init };
