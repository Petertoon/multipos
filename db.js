// Database connection and schema. Tables are created automatically on startup.
const { Pool } = require('pg');

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
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check CHECK (payment_method IN ('cash','card','other','split'));
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
ALTER TABLE sale_payments DROP CONSTRAINT IF EXISTS sale_payments_method_check;
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_method_check CHECK (method IN ('cash','card','other','gift_card'));
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS gift_card_id INT REFERENCES gift_cards(id) ON DELETE SET NULL;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check CHECK (payment_method IN ('cash','card','other','split','gift_card'));

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
`;

async function init() {
  await pool.query(schema);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
}

module.exports = { pool, init };
