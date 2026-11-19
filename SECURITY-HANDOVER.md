# Security Handover: Support Access Codes and Account Recovery (from MultiPOS v1.15)

Use this to give all of Peter's programs the same protection:

1. **Support access codes.** The platform admin (and any helpers with admin logins) can only open a customer's account with a **one-time 6-digit code from the account owner**. Every visit is logged, and the owner can see the log.
2. **Account recovery.** Every owner and admin keeps a **backup email**. **Forgot password?** emails a one-time reset link to **both** the login email and the backup email.

It was built and tested in MultiPOS (Node/Express, Postgres, plain HTML/JS). Nothing depends on a framework. The full working code is in MultiPOS `server.js` (search for `Support access` and `Login security`), `db.js`, `email.js`, `public/admin.html`, `public/login.html` and `public/reset.html`.

**Words used here.** An *account* is one customer's space in a program: a "business" in MultiPOS, a "board" or "family" in HomeBoard, a "ranch" in Farm & Ranch. The *owner* is that account's main login. *Support* or *admin* means Peter and his helpers.

---

## 1. Rules (keep these the same in every program)

**Support access**
- The admin's **Open** or **View** button for an account asks for a code. It doesn't open the account directly.
- The code reaches the owner in one of two ways:
  - **Emailed:** support clicks "Email a code", and the code goes to the owner's main email, backup email, or both.
  - **Made by the owner:** in Settings → **Support access**, the owner clicks "Make a code for support" and reads it over the phone. This works without email.
- Each code is **6 digits**, works **once**, for **15 minutes**, and stops working after **5 wrong tries**. At most **5 codes can be emailed per hour** per account.
- Codes are **never stored as text**, only as a SHA-256 hash.
- Access lasts **4 hours**. After that, or after "Back to all accounts", support needs a new code. The banner shows "until 11:36 AM".
- **Setup days:** for the first **3 days** after an account is created, support can open it without a code. It's still logged.
- **No back doors.** While inside an account, support **cannot**:
  - add logins,
  - change passwords,
  - change or turn off the owner's login.

  Otherwise a helper could make themselves a login and come back without a code. These are allowed during setup days and logged.
- **Everything is logged** with who did it and when, and the owner sees the list in Settings → "Who opened your account":
  - code emailed, and to which email,
  - code made by the owner,
  - opened with an emailed code, with an owner's code, or during setup days,
  - wrong code entered,
  - left the account,
  - password or backup email changed.

  Support can't make codes for the owner or erase the log.

**Account recovery**
- **Owners and platform admins must have a backup email.** Employees can add one if they want.
- The backup email must be different from the login email. It's asked for whenever they change their password, in the same form, and saving needs the current password.
- Until it's added, owners and admins see a yellow bar: "Add a **backup email**… **Add it now**."
- **Forgot password?** on the sign-in page sends a reset link to the **login email and the backup email**. The link:
  - works **once**, for **30 minutes**,
  - only the newest link works,
  - is stored as a hash.
- The forgot page gives **the same answer whether or not the email has a login**, so nobody can test which emails exist. It's rate limited to 5 requests per hour per IP and email.
- Resetting **signs out every device**. Owners must confirm a backup email on the reset page.
- Any password or backup-email change sends a **"Your login was changed"** email to the login email and the old and new backup emails, so a real owner finds out if someone else did it.
- Only the person can change their own backup email. Support can't, even from inside the account.

---

## 2. Database

```sql
-- Support access
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS acting_until TIMESTAMPTZ;   -- when the admin's access to an account ends
CREATE TABLE IF NOT EXISTS support_codes (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,  -- rename to the program's account table
  code_hash TEXT NOT NULL,
  made_by TEXT NOT NULL,                 -- 'email' (support asked) or 'owner' (owner made it in Settings)
  requested_by INT REFERENCES users(id) ON DELETE SET NULL,
  attempts INT NOT NULL DEFAULT 0,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_codes_biz ON support_codes (business_id, created_at DESC);
CREATE TABLE IF NOT EXISTS support_access_log (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,                        -- kept even if the user is deleted later
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_log_biz ON support_access_log (business_id, created_at DESC);

-- Account recovery
ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_email TEXT;
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The program's account table needs a `created_at` column for setup days.

---

## 3. Server routes

| Route | Who | What it does |
|---|---|---|
| `GET /api/admin/access/:id` | admin | Info for the Open window: name, setup days or not, masked main and backup email (`o***r@molino.com`), whether email works |
| `POST /api/admin/access/:id/send` `{to: main\|backup\|both}` | admin | Emails a new code (older unused emailed codes stop working). Max 5 per hour. Logged. |
| `POST /api/admin/enter/:id` `{code}` | admin | Checks the code (or setup days), marks it used, sets `acting_business_id` + `acting_until = now()+4h`. Logged. |
| `POST /api/admin/exit` | admin | Leaves the account. Logged. |
| `POST /api/support/code` | **real owner only** | Makes a code for the owner to read to support. Returns the code once. Logged. |
| `GET /api/support/log` | owner | Last 50 log entries |
| `POST /api/me/password` `{current, password?, backup_email}` | anyone logged in | Changes password and/or backup email. Needs the current password. Backup required for owner/admin. Signs out other devices on a password change. Emails a notice. Logged. |
| `POST /api/password/forgot` `{email}` | public | Emails the reset link to the login email and backup email. Always answers `{ok:true}`. |
| `POST /api/password/reset` `{token, password, backup_email}` | public | Sets the new password (and backup email for owners), uses up the link, signs out all devices, emails a notice, and logs it |

### Key pieces of code

**Hash and make codes:**
```js
const hashCode = (c) => crypto.createHash('sha256').update('mp-support:' + c).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
```

**Access ends on its own.** Do this in the "who is logged in" query, so an expired grant just disappears:
```sql
SELECT u.*, CASE WHEN s.acting_until > now() THEN s.acting_business_id END AS acting_business_id, s.acting_until
  FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now() AND u.active
```

**Checking a code on enter:**
```js
const codes = (await pool.query(`SELECT * FROM support_codes WHERE business_id=$1 AND used_at IS NULL
    AND expires_at > now() AND attempts < 5 ORDER BY created_at DESC`, [id])).rows;
const hit = codes.find((x) => x.code_hash === hashCode(code));
if (!hit) {                                            // count the wrong try against every open code
  if (codes.length) await pool.query('UPDATE support_codes SET attempts = attempts + 1 WHERE id = ANY($1)', [codes.map((x) => x.id)]);
  await supportLog(id, req.user, 'Wrong code entered');
  fail(403, 'That code is not right…');
}
await pool.query('UPDATE support_codes SET used_at = now() WHERE id = $1', [hit.id]);
await pool.query(`UPDATE sessions SET acting_business_id=$1, acting_until=now() + interval '4 hours' WHERE token=$2`, [id, sessionToken]);
```

**Real owner only.** The platform admin "acting as owner" must not pass this check:
```js
const realOwner = (req, res, next) => (req.user.role === 'owner' ? next() : next(new HttpError(403, 'Only the business owner can do this')));
```

**No back doors.** Call this at the top of "add login", in "change someone's password", and when the target or new role is owner:
```js
async function noBackdoor(req, what) {
  if (req.user.role !== 'admin') return;                       // only support is limited
  const b = await ownerOf(req.user.business_id);               // includes in_setup (created within 3 days)
  if (!b.in_setup) fail(403, `For the owner's security, support can't ${what}. Ask the owner to do it.`);
  await supportLog(b.id, req.user, `During setup: ${what}`);
}
```

**Forgot password.** Build the link with the token after `#`, so it never shows up in server logs:
```js
const t = token(24);                                           // random URL-safe string
await pool.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [u.id]);  // old links die
await pool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`,
  [u.id, sha256(t)]);
const link = `${origin}/reset#${t}`;
for (const to of new Set([u.email, u.backup_email].filter(Boolean))) await sendEmail({ to, subject: 'Reset your password', ... });
res.json({ ok: true });                                        // same answer even if no such user
```

**Masking emails** for the support screen:
```js
const maskEmail = (e) => (e ? e.replace(/^(.)(.*)(.@.*)$/, (m, a, b, c) => a + '*'.repeat(Math.min(b.length, 6)) + c) : null);
```

**Email.** MultiPOS uses **Resend** (`email.js` → `sendEmail({to, subject, text, html})`), sending from `receipts@lokaalhub.com`. Render needs `RESEND_API_KEY`. Without it, emailed codes and reset links are turned off and say so. Owner-made codes still work. One verified domain and API key can serve all of Peter's programs.

---

## 4. Screens

- **Admin → Open / View account:** a 🔒 window with a short explanation, a "Send to" menu (owner's email, backup email, both), an **✉️ Email a code** button, a big 6-digit code box, and **Open**. A note appears during setup days. If email isn't available, it says "Ask the owner to make a code in Settings → Support access."
- **Banner while inside:** "You are working inside **Store** as platform administrator until 11:36 AM. [Back to all businesses]"
- **Owner → Settings → 🔒 Support access:** the explanation, a **Make a code for support** button that shows `588 299` in large type, and a **Who opened your account** table (When, Who, What).
- **Everyone → Settings → My login & backup email:** shows the login email, then fields for backup email, new password (blank keeps it) and current password (needed), and a **Save** button.
- **Yellow bar** for owners and admins with no backup email: "Add a backup email… [Add it now]"
- **Sign-in page:** a **Forgot password?** link, which shows the email box and the "If that email has a login, a reset link is on its way…" message.
- **`/reset` page:** new password, type it again, backup email (required for owners), then Save. It says "All devices were signed out" and links to Sign in.
- Customer-facing and print pages are not affected.

---

## 5. Test checklist (all passed in MultiPOS)

1. Open without a code → refused. With a wrong code → refused and logged. With the emailed code → opens, and the banner shows when access ends.
2. Use the same code again → refused (used once).
3. Owner makes a code → support opens with it. Support (as owner) tries to make a code → refused.
4. Set `acting_until` in the past → support is out of the account.
5. Inside the account, support tries to add a login, change the owner's password, or turn off the owner → all refused. Renaming a cashier still works.
6. A new account (under 3 days old) → opens without a code, and it's logged.
7. Forgot password for an unknown email → `{ok:true}` and no email sent. For a real login → emails go to the login and backup emails.
8. Reset an owner without a backup → refused. With backup = login email → refused. Valid → works and all sessions end. Reuse the link → refused.
9. Change backup email → notice to old and new backup emails and the login email. Shows in the owner's log.
10. Send a code to "both" → two emails, and the log says "main and backup email".

---

## 6. Adapting to another program

- Rename `business_id` / `businesses` to that program's account table. Rename the "Open" button and banner to match the program's words, for example HomeBoard's "Admin view of …".
- If the program has no platform admin "enter" feature, add only the account recovery part (backup email + forgot password).
- If a program has several logins per account, the code always goes to the **owner** (first active owner login).
- Keep the numbers the same everywhere (15 minutes, once, 5 tries, 4 hours, 3 setup days, 30-minute reset link) so Peter's customers learn one set of rules.
- Use the program's Dark/Ranch theme for these screens (see THEME-HANDOVER.md). They use normal `.modal`, `.banner`, `.settings` and `table.list` classes.

---

## 7. Starter prompt for another chat

> I want this program to have the same customer-information security as my MultiPOS. The handover is attached (`SECURITY-HANDOVER.md`). Add both parts:
> (1) **Support access codes**: my admin Open/View button needs a one-time 6-digit code from the account owner (emailed to their main/backup email, or made by the owner in Settings), access lasts 4 hours, every visit is logged for the owner, and support can't add logins or change passwords inside an account (except the first 3 setup days).
> (2) **Account recovery**: a required backup email for owners and admins, asked when changing the password, and a "Forgot password?" link that emails a 30-minute one-time reset link to both emails, with change notices.
> Use the same rules, numbers and wording as the handover, and Resend for email (`RESEND_API_KEY`, from `receipts@lokaalhub.com`). Test every item in the checklist, send me screenshots, and give me the changed files one at a time, telling me which go in `public`.
