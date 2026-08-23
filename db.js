// db.js — real, persistent SQLite database using Node's built-in node:sqlite module.
// No npm install needed: node:sqlite ships with Node.js itself (v22.5+).
// The file goldcomfort.db is created next to this script and survives server restarts.

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB_PATH = path.join(__dirname, 'goldcomfort.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0,
    -- Customer wallet
    available_balance INTEGER NOT NULL DEFAULT 0,
    withdraw_bank_name TEXT,
    withdraw_bank_acct TEXT,
    withdraw_bank_acct_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Real login sessions. Issued once after a real Google sign-in; the browser
  -- gets an httpOnly cookie holding this token, so a returning visit skips the
  -- Google button (Google isn't re-verified each time — but signing in fresh
  -- always issues a new session, and a session cannot be created any other way).
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Identity is verified with NIN + selfie face-match only. BVN is collected
  -- separately, later, only as a payout bank detail (see resellers.bank_acct) —
  -- it is not part of the identity check itself.
  CREATE TABLE IF NOT EXISTS verified_identities (
    email TEXT PRIMARY KEY,
    fullname TEXT NOT NULL,
    phone TEXT NOT NULL,
    nin TEXT NOT NULL,
    selfie_photo TEXT,
    dob TEXT NOT NULL,
    verified_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS resellers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    biz_name TEXT NOT NULL,
    biz_state TEXT NOT NULL,
    address TEXT,
    location_pinned INTEGER NOT NULL DEFAULT 0,
    bank_name TEXT,
    bank_acct TEXT,
    bank_acct_name TEXT,
    plan TEXT NOT NULL DEFAULT 'Pro (₦6,000/mo)',
    plan_expires_at TEXT NOT NULL,
    interest_while_expired INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'self',
    -- Reseller wallet — available_balance and total_earning are real stored
    -- balances (only ever changed by a wallet_transactions entry). Pending
    -- balance is NOT stored here — it's computed live from orders currently
    -- in progress (preparing/on-way/arrived), so it can never drift out of sync.
    available_balance INTEGER NOT NULL DEFAULT 0,
    total_earning INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_email) REFERENCES users(email)
  );

  -- No delivery-area gate: a listing just goes live everywhere. The reseller
  -- decides per order whether they can fulfill it (Accept) or not (Reject —
  -- e.g. the buyer is too far away), and a reject always refunds the buyer.
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    price_text TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'product', -- 'product' | 'service'
    photos TEXT, -- JSON array of up to 5 data-URLs/photo strings
    viewers INTEGER NOT NULL DEFAULT 0, -- reseller-set display number
    rating REAL NOT NULL DEFAULT 0, -- reseller-set display rating (0-5)
    discount_code TEXT,
    discount_percent INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (reseller_id) REFERENCES resellers(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL,
    reseller_id INTEGER NOT NULL,
    buyer_email TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    subtotal INTEGER NOT NULL,
    fee INTEGER NOT NULL DEFAULT 0,
    discount_applied INTEGER NOT NULL DEFAULT 0,
    credit_used INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    commission INTEGER NOT NULL,
    reseller_payout INTEGER NOT NULL,
    cust_state TEXT,
    address TEXT NOT NULL,
    cust_phone TEXT,
    cust_whatsapp TEXT,
    cust_email TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    -- pending (seller must Accept/Reject) -> preparing -> on-way -> arrived -> delivered
    -- or: seller-declined (any reason, incl. buyer too far — always refunds the buyer)
    -- or: expired (reseller missed their own delivery deadline — always refunds the buyer)
    expected_delivery_at TEXT, -- set by reseller when they Accept
    ordered_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    FOREIGN KEY (listing_id) REFERENCES listings(id),
    FOREIGN KEY (reseller_id) REFERENCES resellers(id)
  );

  -- Every wallet movement, for every party (admin/reseller/customer), so
  -- balances are always explainable — never just a number with no history.
  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL, -- 'admin' | 'reseller' | 'customer'
    owner_id TEXT NOT NULL, -- reseller.id (as text) for resellers, email for admin/customer
    direction TEXT NOT NULL, -- 'credit' | 'debit'
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason TEXT NOT NULL,
    related_order_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Static virtual account numbers (Flutterwave) for top-ups. One per person —
  -- any transfer to this number tops up their GoldComfort wallet automatically.
  CREATE TABLE IF NOT EXISTS virtual_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL, -- 'reseller' | 'customer'
    owner_id TEXT NOT NULL,
    account_number TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    flw_reference TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_type, owner_id)
  );

  CREATE TABLE IF NOT EXISTS order_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    from_role TEXT NOT NULL, -- 'customer' | 'reseller'
    text TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );

  -- "Buy Requests": someone wants to buy something (crypto, a specific item, etc).
  -- GoldComfort never handles the money here — it's a verified-to-verified
  -- introduction + chat only. Reporting/banning still applies.
  CREATE TABLE IF NOT EXISTS buy_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id)
  );

  CREATE TABLE IF NOT EXISTS buy_request_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buy_request_id INTEGER NOT NULL,
    from_email TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (buy_request_id) REFERENCES buy_requests(id)
  );

  -- Reports for abuse anywhere in the app (Buy Requests, chat, orders, etc.)
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_email TEXT NOT NULL,
    reported_email TEXT NOT NULL,
    reason TEXT NOT NULL,
    context TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0
  );

  -- Coupons: two kinds —
  --   'signup'  = GoldComfort-issued, given to a customer to encourage them to
  --               become a reseller (percent off their first plan payment, or
  --               100% = free). Can target everyone or one specific person,
  --               and can optionally expire (e.g. a weekend-only promo).
  --   'product' = a reseller's own discount code on their own listing(s)
  CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL, -- 'signup' | 'product'
    reseller_id INTEGER,
    discount_percent INTEGER,
    audience TEXT NOT NULL DEFAULT 'all', -- 'all' | 'specific' (signup coupons only)
    target_email TEXT, -- set when audience = 'specific'
    expires_at TEXT, -- optional — null means no expiry
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (reseller_id) REFERENCES resellers(id)
  );

  -- Home screen banner slides — an admin-managed carousel. Each slide can
  -- have an image, text, or both. New slides are added, not replaced; the
  -- admin removes one explicitly (delete) when it should stop showing.
  CREATE TABLE IF NOT EXISTS banner_slides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image TEXT, -- data URL, nullable
    text TEXT, -- nullable
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Ad-hoc discretionary credit: a reseller can grant a specific buyer a naira
  -- credit at any time (not a code). It lives on the BUYER's account and can be
  -- spent on ANY future order from ANY reseller. GoldComfort absorbs the
  -- difference — the fulfilling reseller is always paid their full amount.
  CREATE TABLE IF NOT EXISTS customer_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_email TEXT NOT NULL,
    amount INTEGER NOT NULL,
    granted_by_reseller_id INTEGER,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    used INTEGER NOT NULL DEFAULT 0,
    used_order_id INTEGER,
    FOREIGN KEY (granted_by_reseller_id) REFERENCES resellers(id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    audience TEXT NOT NULL, -- 'all' | 'reseller' | 'customer'
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notification_reads (
    notification_id INTEGER NOT NULL,
    user_email TEXT NOT NULL,
    PRIMARY KEY (notification_id, user_email)
  );

  CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    from_role TEXT NOT NULL, -- 'user' | 'bot' | 'admin'
    text TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_email) REFERENCES users(email)
  );

  CREATE TABLE IF NOT EXISTS support_threads (
    user_email TEXT PRIMARY KEY,
    escalated INTEGER NOT NULL DEFAULT 0,
    unread_for_admin INTEGER NOT NULL DEFAULT 0,
    unread_for_user INTEGER NOT NULL DEFAULT 0
  );

  -- Admin-editable app-wide settings, e.g. the scrolling Home banner message.
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Customer-submitted star ratings (1-5) per listing. listings.rating is the
  -- average of these, kept in sync automatically — admin can also override it directly.
  CREATE TABLE IF NOT EXISTS listing_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL,
    customer_email TEXT NOT NULL,
    stars INTEGER NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(listing_id, customer_email),
    FOREIGN KEY (listing_id) REFERENCES listings(id)
  );

  -- Short-lived phone OTP codes (Termii) for reseller registration phone verification.
  CREATE TABLE IF NOT EXISTS otp_codes (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0
  );
`);

module.exports = db;
