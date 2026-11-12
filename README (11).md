# MultiPOS — Version 1

A point of sale for many businesses on one platform. Each business has its own
locations, registers, products, employees and sales. A computer runs the checkout
screen; any phone becomes a wireless barcode scanner by scanning the register's QR code.

## What works in Version 1
- Platform administrator account (you) that creates businesses and can open any of them for support
- Businesses → locations (each with its own sales tax rate) → registers
- Employees with roles: Owner, Manager, Cashier
- Products with barcode, category, price, taxable flag, optional stock tracking
- Checkout screen: scan box (works with USB scanners too), tap-to-add product tiles by category,
  custom amounts, quantity changes, cash (with change), card (run on your separate terminal), other
- Phone scanner page: camera scanning (UPC, EAN, Code 128, Code 39, QR), type a barcode,
  custom amount, and "not found → enter a price"
- Live updates: items scanned on the phone appear on the register screen instantly
- Printable receipts (any printer the computer can print to)
- Sales report by date and location, with cash/card/other totals, tax collected, and void

## Files
- `server.js` — all server routes
- `db.js` — database tables (created automatically on startup)
- `public/` — the pages: `login`, `setup`, `checkout`, `scan` (phone), `admin` (Manage), `receipt`

## Deploy on Render
1. Create a new GitHub repository (for example `multipos`) and upload everything in this folder
   except `node_modules`.
2. In Render: **New → PostgreSQL**. Create it, then copy its **Internal Database URL**.
3. In Render: **New → Web Service**, connect the GitHub repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variable: `DATABASE_URL` = the Internal Database URL from step 2
   - Optional: `PUBLIC_URL` = your site address (only needed if you use a custom domain)
4. Open the site. The first visit goes to **First-time setup**, where you create your
   administrator login. That page locks itself after one use.
5. In **Businesses**, create a business. Then press **Open** to add products and employees.

Keep this service at **one instance**. Live phone-to-register updates are held in the
server's memory. The free plan sleeps when idle, so use the Starter plan for a store that's open.

## Using the phone scanner
On the checkout screen, scan the QR code in the "Phone scanner" box with the phone's camera
and open the link. Tap **Start camera** and allow camera access. Each register has its own
code. **New code** disconnects every phone paired to that register.

## Not in Version 1 (later)
Card processing integration, emailed/WhatsApp receipts, product photos, CSV product import,
returns/refunds, cash drawer counts, and receipt printing to network thermal printers.
