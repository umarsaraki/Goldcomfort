# GoldComfort

One project. One command. Frontend, backend, and a real database, all together.

```bash
node server.js
```

Then open **http://localhost:3000**. No `npm install`, no separate frontend/backend
projects. Every action in the browser is a real HTTP request to a real endpoint
reading/writing a real database file (`goldcomfort.db`, created next to `server.js`
the first time you run it).

## Project layout

```
goldcomfort-app/
├── server.js       ← the whole backend: serves the frontend AND the API, same port
├── db.js           ← the database schema (SQLite, via Node's built-in node:sqlite)
├── public/
│   └── index.html  ← the whole frontend (mobile-first web app)
├── package.json
├── .gitignore
└── .env.example    ← copy to .env and fill in real keys when you have them
```

## What's in this build

**Identity & onboarding**
- Sign-in creates a real user row. Reseller identity check is **NIN + selfie only**
  (no BVN) — cached so the same person is never re-checked twice.
- Real phone OTP flow (stubbed for Termii — see below) during sign-up.
- Automatic first-time-reseller discount, applied once per person, ever:
  Starter ₦2,000→₦1,500, Pro ₦6,000→₦4,000, Business ₦12,000→₦7,000.
- Map location pinning is optional everywhere (reseller registration, checkout).

**Listings**
- Up to 5 photos per listing, full reseller edit control (name, description,
  price, photos, their own discount code).
- No delivery-area system — a listing is visible everywhere. The reseller
  decides per order whether to Accept or Reject (e.g. buyer too far); a reject
  always means a refund.
- Viewers auto-count on every product-page view; star rating is a live average
  of real customer 1–5 ratings. Only the **admin** can manually override either
  number (Admin Panel → a reseller's product edit modal).

**Discounts & coupons (three separate systems)**
1. Automatic first-time-reseller discount (above) — system rule, not a coupon.
2. A reseller's own product discount code — reduces both what the buyer pays
   and the reseller's payout base (it's their own promotion).
3. Ad-hoc customer credit ("ragowa") — a reseller can grant a specific buyer a
   naira credit any time. It lives on the buyer's account, is spendable on
   *any* future order from *any* reseller, and GoldComfort absorbs the
   difference — the fulfilling reseller is always paid in full.
4. Admin-issued signup coupons — percent off a customer's first reseller plan
   payment, to attract new sellers (Admin Panel → Coupons).

**Book tab**
- Split into **Services** and **Buy Requests**.
- Buy Requests: a verified reseller posts "I want to buy X"; anyone responds
  via in-app chat. GoldComfort never touches money here — a clear warning is
  shown, and a **Report** button is always available (reviewed in Admin Panel).

**Admin Panel**
- Editable Home banner (shown as a scrolling strip; falls back to a customer's
  own available credit, then a default message, if left blank).
- Signup coupon manager, reports queue, support inbox.
- Reseller/customer lists sortable by join date or by total sales/spend — so
  you can see who's earned a bonus coupon at a glance.

**Payments (Profile → Payment Methods)**
- Customers pick a payment preference (Card or Transfer) — no card number
  ever stored.
- Resellers see their registered payout account and full payout history.

**Everything else already real from before:** the escrow-style order lifecycle
(pending → seller Accept/Reject → preparing → on-way → arrived → buyer
confirms → instant payout), notifications, support chat with bot + human
escalation, bans, and plan expiry/renewal (renewal can switch to a *cheaper*
tier — no need to re-verify).

## The keys that still need to be real

Five functions near the top of `server.js`, each with the real implementation
sketched in a comment above it:

```js
function verifyNin(nin, selfiePhoto)   // → real NIN + face-match (Dojah/Youverify/Flutterwave)
function flutterwaveTransfer(r, amt)   // → real Flutterwave Transfer API call
function verifyGoogleToken(token, ..)  // → real Google ID token verification
// plus /api/otp/send and /api/otp/verify → real Termii SMS OTP calls
```

Until you have those keys, the app runs the exact same logic against stubs —
build and test the whole flow first, then fill in `.env` (copy `.env.example`)
when you're ready. **Never put a real key directly in the code.**

## Deploying so it's live on the internet

Any host that runs `node server.js` and lets you set environment variables
works, with no code changes: **Render** or **Railway** (connect the repo, set
the `.env.example` variables in their dashboard), or **a VPS** (`git clone`,
`node server.js`, kept alive with `pm2` or `systemd`).

## Known gaps (so nothing here is oversold)

- The stubbed functions above return success without contacting a real
  provider, until real keys are set.
- SQLite is genuinely persistent and fine for testing/modest traffic; a
  high-traffic production deployment would eventually want Postgres — the
  schema in `db.js` is plain SQL and easy to port.
- Photos are stored as data URLs directly in the database — fine for testing,
  but real image hosting (e.g. S3-compatible storage) is worth adding before
  heavy use.
- The Flutterwave webhook router (to share one webhook URL between this app
  and another Flutterwave-connected app) was discussed but not yet built —
  flagged for a future session.
