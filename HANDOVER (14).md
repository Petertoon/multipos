# MultiPOS — Build Handover

Last updated: 2026-11-13 · Current version: **v1.11.0**

This document explains how MultiPOS was built, so a new project (a **contractor POS**) can start from the same foundation. Attach this file and the latest `multipos-v1.10.zip` to the new conversation.

---

## 1. What MultiPOS is

A web-based point of sale for **many businesses, each with many locations and registers**, run by one platform administrator (you), who provides it as a service to store owners.

- Runs in any browser (PC, tablet, phone). No app install.
- **Phones act as wireless barcode scanners**: scan a QR code on the register, and anything the phone's camera scans lands in that register's cart instantly.
- Built "basics first, extras later", one feature at a time, each tested end to end in a real browser against a real database before delivery.

---

## 2. Hosting, stack, deploy

| Piece | What's used |
|---|---|
| Code | GitHub repo `Petertoon/multipos`, branch `main` |
| Hosting | Render **Web Service** (`multipos`, Node), live at `https://multipos-hv55.onrender.com` |
| Database | Render **PostgreSQL** (connected via `DATABASE_URL`) |
| Runtime | Node 18+, Express 4, `pg`, `bcryptjs`, `cookie-parser`, `qrcode` |
| Scanner libraries | `barcode-detector@2.3.1` and `zxing-wasm@1.3.4` (exact versions pinned), served from `/vendor` |
| Front end | Plain HTML + JavaScript pages in `public/` — no React, no build step |

**Deploy flow:** upload changed files (or the whole zip) to GitHub → Render auto-deploys from `main`. The database schema creates/updates itself on startup — there are no manual migrations.

**Render environment variables**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (from the Render database) |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | Intuit app keys (QuickBooks Online) |
| `QBO_ENVIRONMENT` | `sandbox` now; `production` later |
| `RESEND_API_KEY` | Email receipts (resend.com) |
| `RECEIPT_FROM_EMAIL` | Optional; defaults to `receipts@lokaalhub.com` |

Secrets go **only** into Render's Environment page — never into chat or GitHub.

---

## 3. File map and architecture

```
multipos/
  server.js        All API routes (~80): auth, businesses, locations, registers, cart, checkout,
                   products, pending items, rentals, refunds, gift cards, customers, quotes,
                   reports, deposits, sales, receipts. Live updates via Server-Sent Events.
  db.js            Whole database schema. Runs on every startup (CREATE ... IF NOT EXISTS,
                   ALTER ... ADD COLUMN IF NOT EXISTS). One multi-statement query.
  qbo.js           QuickBooks Online live sync (OAuth, account mapping, daily journal entries, deposits).
  email.js         Email receipts through Resend.
  package.json     Dependencies + "start": "node server.js"
  public/
    app.js         Shared browser helpers: api(), money(), toast(), receipt/quote layouts,
                   WhatsApp, text and email send dialogs.
    hours.js       Business hours + rental due-time math. Shared by server AND browser.
    style.css      Shared styles.
    checkout.html  The register screen (cart, pay, split pay, customers, PO/job site, fees,
                   quotes, rentals, phone-scanner QR, WhatsApp box).
    admin.html     "Manage" screens: Businesses (platform admin), Products, Pending items,
                   Refunds owed, Customers, Reports, Deposits, QuickBooks, Locations,
                   Employees, Sales, Settings.
    scan.html      Phone scanner page (camera, flashlight, add-unknown-item to pending).
    login.html, setup.html, index.html
    receipt.html, invoice.html (full-page invoice), r.html (customer receipt link), quote.html, giftcard.html,
    statement.html (customer account statement), deposit.html (deposit slip), receipt.css
```

**Key patterns**
- **Accounts & roles:** `admin` (platform — you), `owner`, `manager`, `cashier`. The platform admin can "enter" any business (`acting_business_id`) to help set it up.
- **Sessions:** a `sessions` table + an httpOnly cookie named `mp_session`.
- **Every query is scoped by `business_id`**, so one store can never see another's data.
- **Live register:** each register's cart is stored in the database (JSONB). Phone scans and register changes push updates over Server-Sent Events.
- **Phone pairing:** the register shows a QR code for `/scan#<pair_token>`; "New code" rotates the token.
- **Add-ons switched on per business** by the platform admin: Rentals, QuickBooks.

---

## 4. Data model

Tables: `businesses`, `locations`, `registers`, `users`, `sessions`, `products`, `sales`, `sale_items`, `sale_payments`, `pending_items`, `rentals`, `gift_cards`, `refunds`, `customers`, `account_payments`, `deposits`, `quotes`, `qbo_connections`, `qbo_syncs`.

**Rules that matter**
- **Money is always whole cents (integers).** Never floats.
- Product photos are resized in the browser (JPEG, max 600 px) and stored in the database (BYTEA).
- `DATE` columns come back as plain strings (type parser `1082`) to avoid time-zone shifts.
- Payment-method CHECK constraints are defined **once, at the end of the schema**:
  - `sale_payments.method`: cash, card, other, gift_card, check, account
  - `sales.payment_method`: the same plus `split`
- Locations carry their own tax rate and (since v1.10) business hours (`hours` JSONB).

---

## 5. Features built (in order)

| Version | Added |
|---|---|
| v1.0 | Businesses/locations/registers/users, products, register checkout, cash/card/other, receipts, phone scanner pairing |
| | Product photos |
| | WhatsApp receipts (link to a customer receipt page) |
| | Scanner: green/red camera button, flashlight auto-on, directions; switched to `barcode-detector` + ZXing for reliable reads |
| | **Pending items**: unknown barcode → temporary name, photo, price → management approves into the product list |
| | WhatsApp box under the scanner that reuses one tab (app or web mode) |
| | **Split pay** (any mix of methods, split evenly) |
| | **Rentals add-on**: prepaid half day / day / week / month; late return = custom charge; early return refund as cash, gift card, or check (Refunds-owed ledger) |
| v1.x | **Contractor-style list**: PO #, quotes tied to a phone number, job site address/GPS, delivery fee, fuel charge (amount or %), customer list with **charge accounts** (credit limit, statements, payments), tax report (day/week/month/year), cash & checks collected, **deposit slips**, checks with check numbers |
| v1.7 | Constraint cleanup (fixes restart crash after gift-card/check/account sales) |
| v1.8 | **QuickBooks Online live sync** (phase 1) |
| v1.9 | **Text and email receipts** |
| v1.10 | **Business hours per location**; rental time skips closed hours |
| v1.11 | **Pickup / Delivery** on sales, **fuel charge by the gallon**, **full-page invoice** (customer details top left), **notes on invoices and statements**, **statements for any date range** |

---

## 6. Integrations

**Phone scanner** — `scan.html` uses the camera with `barcode-detector` (ZXing WebAssembly underneath). Camera must be on HTTPS (Render provides it). Directions are shown on screen.

**WhatsApp** — opens WhatsApp (desktop app or one reused web tab) with the receipt text and link. No API cost.

**Text** — opens the device's Messages app with a short message + receipt link (`sms:` link). Free; works on phones/tablets (Windows needs Phone Link). Automatic server texting (Twilio, ~1¢/text + $1.15/mo number + one-time A2P 10DLC registration) was deferred.

**Email** — server sends via **Resend** from `receipts@lokaalhub.com` with the store's name as sender; replies go to the store's reply-to email (Settings) or the owner's login email. Free tier 3,000/month. Setup: verify `lokaalhub.com` in Resend (DNS records in Wix) → create API key → `RESEND_API_KEY` in Render.

**QuickBooks Online** (per business, OAuth2):
- Intuit developer app "Test App" in workspace "Petertoon" (sandbox). Redirect URI: `https://multipos-hv55.onrender.com/api/qbo/callback`. Scope `com.intuit.quickbooks.accounting`.
- One **journal entry per location per day** (DocNumber `MP<location>-<YYYYMMDD>`), updated or deleted if the day changes later (voids). Each MultiPOS **deposit** becomes a QuickBooks Deposit to the chosen bank.
- Uses MultiPOS clearing accounts instead of Undeposited Funds. "Create recommended accounts" makes 11 accounts.
- Hourly automatic sync; a day is sent after it ends. Tokens encrypted (AES-256-GCM).
- Connected and tested against **Sandbox Company US a760**.
- **Phase 2 (not built):** charge accounts as real QuickBooks Customers/Invoices/Payments (A/R); production keys (Intuit app review).

---

## 7. Lessons learned / gotchas

- **Build in small steps and test each one end to end** (real Postgres + real browser) before shipping.
- **The schema runs as one implicit transaction on startup** — one bad statement rolls back everything and the server won't start. Put constraints once, at the end.
- **Copying text from chat can add hidden characters** (line breaks/spaces) — the Intuit redirect URI failed until it was typed by hand (count characters: 51).
- Render's **Manual Deploy menu** doesn't save environment changes — use **Save, rebuild, and deploy**.
- Intuit permissions page shows Accounting/Payments **grayed out but on** — that's normal.
- **Never paste secrets into chat**; hide them before screenshots (Render's eye icon).
- Time zones: business days use `America/Chicago` by default; compute "days" in the business's zone, not the server's (UTC).
- Phone camera scanning needs good light, the barcode filling about half the frame, and HTTPS.

---

## 8. Starting a contractor POS from this

**Already done in MultiPOS that a contractor POS needs:** PO numbers, quotes by phone number, job site address/GPS, delivery & fuel charges, charge accounts with credit limits and statements, checks and deposit slips, tax reports, rentals (equipment), QuickBooks sync, phone scanner, receipts by WhatsApp/text/email.

**Decide first:** fork MultiPOS into a new repo (fastest — keep everything, add contractor features) **or** add a "contractor" business type to MultiPOS (one system to maintain). Recommended: decide based on whether contractor customers need a very different register screen.

**Likely new features to scope:**
- Jobs/projects as a first-class record (customer → job → sales, quotes, rentals, delivery)
- Quote → approval → convert to invoice/sale; deposits/progress billing
- Net-30 invoicing on charge accounts, aging report, late fees
- Contractor pricing tiers / per-customer price levels, bulk & unit-of-measure pricing (each, box, foot)
- Tax-exempt customers (resale/exemption certificates)
- Special orders / backorders, purchase orders to suppliers, receiving inventory
- Delivery scheduling and proof of delivery (photo/signature on phone)
- QuickBooks phase 2 (Customers, Invoices, Payments)

---

## 9. Starter prompt for the new thread

> I'm building a **contractor POS**. I previously built **MultiPOS** (multi-business web POS with phones as barcode scanners) — the handover and code are attached (`HANDOVER.md`, `multipos-v1.10.zip`). Use the same stack and approach: Node/Express/Postgres on Render, plain HTML/JS front end, money in cents, schema created on startup, deploy via GitHub. Basics first, extras later; test every feature end to end before delivering, and give me files I can upload to GitHub. First, help me decide whether to fork MultiPOS or add a contractor business type, then plan the first phase.
