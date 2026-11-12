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
