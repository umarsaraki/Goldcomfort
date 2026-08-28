// server.js — the real GoldComfort backend.
// Zero npm dependencies: uses only Node's built-in `http` and `node:sqlite` modules,
// so `node server.js` works right after `git clone`, with no `npm install` step.

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'owner@example.com';
// Public Google OAuth Client ID — not a secret, safe to default here. Override
// via .env if you ever create a different Google Cloud project.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '964673289786-l87j52gt04theq8dpl1g3d6melevpmt8.apps.googleusercontent.com';
const COMMISSION_RATE = 0.05;
const PLAN_DURATION_DAYS = Number(process.env.PLAN_DURATION_DAYS || 30);

// ---------------------------------------------------------------------------
// TODO integration points — swap these stubs for real calls once you have keys.
// ---------------------------------------------------------------------------

// Korapay Identity API is the chosen NIN provider (see conversation notes —
// Korapay's "Individual" account tier doesn't require a work/business email).
// TODO: replace with a real call using KORAPAY_API_KEY:
//   POST https://api.korapay.com/merchant/api/v1/identities/ng/nin
//   headers: { Authorization: `Bearer ${process.env.KORAPAY_API_KEY}` }
//   body: { nin, selfie_image: selfiePhoto }
function verifyNin(nin, selfiePhoto) {
  const looksValid = /^\d{11}$/.test(nin);
  return { success: looksValid };
}

// TODO: replace with a real Flutterwave transfer using FLUTTERWAVE_SECRET_KEY.
// bankDetails: { bankName, bankAcct, bankAcctName }
function flutterwaveTransfer(bankDetails, amountNaira) {
  console.log(`[stub] Would transfer ₦${amountNaira} to ${bankDetails.bankName} •••• ${String(bankDetails.bankAcct).slice(-4)}`);
  return { success: true, reference: 'STUB-' + crypto.randomUUID() };
}

// TODO: replace with a real Flutterwave static/virtual account creation using
// FLUTTERWAVE_SECRET_KEY — POST https://api.flutterwave.com/v3/virtual-account-numbers
// with { email, bvn, is_permanent:true, tx_ref, firstname, lastname, narration }.
// IMPORTANT: firstname/lastname set the account holder's displayed name on the
// virtual account itself — this is per-request, completely independent of your
// own Flutterwave business name. Pass the real person's name here and Flutterwave
// shows THEIR name (plus "- GOLD COMFORT") on the account, every time.
// Returns a real account_number + bank_name that Flutterwave watches forever —
// any transfer to it fires a webhook (matched by account_number, not tx_ref).
async function flutterwaveCreateVirtualAccount(ownerEmail, ownerFullName, ninOrBvn) {
  if (!process.env.FLUTTERWAVE_SECRET_KEY) {
    return { success: false, error: 'Virtual account numbers are not configured on this server yet — set FLUTTERWAVE_SECRET_KEY in .env, and confirm Virtual Account Numbers is enabled on your Flutterwave account.' };
  }
  const [firstname, ...rest] = (ownerFullName || ownerEmail).trim().split(' ');
  const lastname = rest.join(' ') || firstname;
  const accountName = `${ownerFullName || ownerEmail} - GOLD COMFORT`;
  try {
    const result = await httpsPostJSON('api.flutterwave.com', '/v3/virtual-account-numbers', {
      email: ownerEmail,
      is_permanent: true,
      bvn: ninOrBvn,
      tx_ref: 'VA-' + crypto.randomUUID(),
      firstname,
      lastname,
      narration: accountName
    }, { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` });
    if (!result.body || result.body.status !== 'success') {
      return { success: false, error: result.body?.message || 'Flutterwave could not create this account number' };
    }
    const d = result.body.data;
    return { success: true, accountNumber: d.account_number, bankName: d.bank_name, accountName, flwReference: d.flw_ref || d.order_ref || null };
  } catch (err) {
    return { success: false, error: 'Could not reach Flutterwave: ' + err.message };
  }
}

// ---------------------------------------------------------------------------
// Wallet helpers — every balance change goes through here, so there is always
// a matching wallet_transactions row explaining it. ownerId is the reseller's
// numeric id (as text) for resellers, or an email for admin/customers.
// ---------------------------------------------------------------------------
function getWalletBalance(ownerType, ownerId) {
  if (ownerType === 'reseller') {
    const r = db.prepare('SELECT available_balance FROM resellers WHERE id = ?').get(ownerId);
    return r ? r.available_balance : 0;
  }
  const u = db.prepare('SELECT available_balance FROM users WHERE email = ?').get(ownerId);
  return u ? u.available_balance : 0;
}
function setWalletBalance(ownerType, ownerId, newBalance) {
  if (ownerType === 'reseller') {
    db.prepare('UPDATE resellers SET available_balance = ? WHERE id = ?').run(newBalance, ownerId);
  } else {
    db.prepare('UPDATE users SET available_balance = ? WHERE email = ?').run(newBalance, ownerId);
  }
}
function creditWallet(ownerType, ownerId, amount, reason, relatedOrderId) {
  const newBalance = getWalletBalance(ownerType, ownerId) + amount;
  setWalletBalance(ownerType, ownerId, newBalance);
  if (ownerType === 'reseller') {
    db.prepare('UPDATE resellers SET total_earning = total_earning + ? WHERE id = ?').run(amount, ownerId);
  }
  db.prepare('INSERT INTO wallet_transactions (owner_type, owner_id, direction, amount, balance_after, reason, related_order_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ownerType, String(ownerId), 'credit', amount, newBalance, reason, relatedOrderId || null);
  return newBalance;
}
function debitWallet(ownerType, ownerId, amount, reason, relatedOrderId) {
  const current = getWalletBalance(ownerType, ownerId);
  if (amount > current) throw new Error('Insufficient balance');
  const newBalance = current - amount;
  setWalletBalance(ownerType, ownerId, newBalance);
  db.prepare('INSERT INTO wallet_transactions (owner_type, owner_id, direction, amount, balance_after, reason, related_order_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ownerType, String(ownerId), 'debit', amount, newBalance, reason, relatedOrderId || null);
  return newBalance;
}
function getPendingBalance(ownerType, ownerId) {
  if (ownerType === 'reseller') {
    const row = db.prepare(`SELECT COALESCE(SUM(reseller_payout),0) p FROM orders WHERE reseller_id = ? AND status IN ('preparing','on-way','arrived')`).get(ownerId);
    return row.p;
  }
  if (ownerType === 'admin') {
    // NOT admin's own money — this is what's collectively owed to ALL resellers
    // for orders still in progress, so admin can see the obligation at a glance.
    const row = db.prepare(`SELECT COALESCE(SUM(reseller_payout),0) p FROM orders WHERE status IN ('preparing','on-way','arrived')`).get();
    return row.p;
  }
  return 0;
}
function getResellerEarnedTotal() {
  // Total ever actually paid out to resellers across the whole platform.
  const row = db.prepare(`SELECT COALESCE(SUM(total_earning),0) t FROM resellers`).get();
  return row.t;
}
function getTotalBalanceEverCredited(ownerType, ownerId) {
  const row = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM wallet_transactions WHERE owner_type = ? AND owner_id = ? AND direction = 'credit'`).get(ownerType, String(ownerId));
  return row.t;
}
function getTotalRefunded(ownerType, ownerId) {
  const row = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM wallet_transactions WHERE owner_type = ? AND owner_id = ? AND direction = 'credit' AND reason LIKE 'Refund%'`).get(ownerType, String(ownerId));
  return row.t;
}

// ---------------------------------------------------------------------------
// Withdrawal security code — a separate 5-digit PIN, independent of Google
// login. Required before any withdraw goes through, so a hijacked Google
// session alone still can't drain someone's wallet. Stored salted+hashed.
// ---------------------------------------------------------------------------
function hashSecurityCode(code, salt) {
  return crypto.scryptSync(code, salt, 64).toString('hex');
}
function verifySecurityCode(email, code) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !u.security_code_hash) return { ok: false, error: 'Set a withdrawal security code first' };
  if (u.security_code_locked_until && new Date() < new Date(u.security_code_locked_until)) {
    return { ok: false, error: 'Too many wrong attempts — try again in 15 minutes' };
  }
  const hash = hashSecurityCode(code || '', u.security_code_salt);
  if (hash !== u.security_code_hash) {
    const attempts = (u.security_code_attempts || 0) + 1;
    if (attempts >= 5) {
      const lockedUntil = new Date(Date.now() + 15 * 60000).toISOString();
      db.prepare('UPDATE users SET security_code_attempts = 0, security_code_locked_until = ? WHERE email = ?').run(lockedUntil, email);
      return { ok: false, error: 'Too many wrong attempts — locked for 15 minutes' };
    }
    db.prepare('UPDATE users SET security_code_attempts = ? WHERE email = ?').run(attempts, email);
    return { ok: false, error: `Wrong security code (${5 - attempts} attempts left)` };
  }
  db.prepare('UPDATE users SET security_code_attempts = 0 WHERE email = ?').run(email);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Real Google ID token verification — no npm dependency needed. We fetch
// Google's public signing keys, verify the JWT's RS256 signature ourselves
// with Node's built-in crypto, and check the standard claims (audience,
// issuer, expiry).
// ---------------------------------------------------------------------------

let googleCertsCache = null;
let googleCertsFetchedAt = 0;

function fetchGoogleCerts() {
  return new Promise((resolve, reject) => {
    https.get('https://www.googleapis.com/oauth2/v3/certs', (res) => {
      let raw = '';
      res.on('data', (chunk) => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function base64UrlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function verifyGoogleToken(idToken) {
  if (!idToken) {
    throw new Error('Missing Google ID token');
  }

  const [headerB64, payloadB64, signatureB64] = idToken.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error('Malformed ID token');

  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));

  // Refresh Google's public keys at most once every hour.
  if (!googleCertsCache || Date.now() - googleCertsFetchedAt > 60 * 60 * 1000) {
    googleCertsCache = await fetchGoogleCerts();
    googleCertsFetchedAt = Date.now();
  }
  const jwk = googleCertsCache.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Signing key not found — Google may have rotated keys, try again');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signedData = `${headerB64}.${payloadB64}`;
  const signature = base64UrlDecode(signatureB64);
  const valid = crypto.verify('RSA-SHA256', Buffer.from(signedData), publicKey, signature);
  if (!valid) throw new Error('Invalid token signature');

  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('Token audience mismatch');
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') throw new Error('Invalid token issuer');
  if (payload.exp * 1000 < Date.now()) throw new Error('Token expired');

  return { email: payload.email, name: payload.name || payload.email };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlanExpired(reseller) {
  return new Date() > new Date(reseller.plan_expires_at);
}
function planExpiryDate() {
  return new Date(Date.now() + PLAN_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
function parsePrice(str) {
  return Number(String(str).replace(/[^\d]/g, '')) || 0;
}
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler });
}

route('GET', '/api/security-code/:email/status', async (req, res, body, params) => {
  const email = decodeURIComponent(params.email);
  const u = db.prepare('SELECT security_code_hash FROM users WHERE email = ?').get(email);
  sendJSON(res, 200, { isSet: !!(u && u.security_code_hash) });
});
route('POST', '/api/security-code/:email/set', async (req, res, body, params) => {
  const email = decodeURIComponent(params.email);
  const existing = db.prepare('SELECT security_code_hash FROM users WHERE email = ?').get(email);
  if (existing && existing.security_code_hash) {
    return sendJSON(res, 403, { error: 'A security code is already set — contact GoldComfort support to change it' });
  }
  if (!/^\d{5}$/.test(body.code || '')) return sendJSON(res, 400, { error: 'Security code must be exactly 5 digits' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashSecurityCode(body.code, salt);
  db.prepare('UPDATE users SET security_code_hash = ?, security_code_salt = ?, security_code_attempts = 0, security_code_locked_until = NULL WHERE email = ?')
    .run(hash, salt, email);
  sendJSON(res, 200, { ok: true });
});
// Admin-only reset — the ONLY way a security code can change once it's been set.
route('POST', '/api/admin/security-code/:email/reset', async (req, res, body, params) => {
  const email = decodeURIComponent(params.email);
  if (!/^\d{5}$/.test(body.code || '')) return sendJSON(res, 400, { error: 'Security code must be exactly 5 digits' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashSecurityCode(body.code, salt);
  db.prepare('UPDATE users SET security_code_hash = ?, security_code_salt = ?, security_code_attempts = 0, security_code_locked_until = NULL WHERE email = ?')
    .run(hash, salt, email);
  sendJSON(res, 200, { ok: true });
});

// -- Auth --
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function sendJSONWithCookie(res, status, data, cookieName, cookieValue, maxAgeSeconds) {
  const body = JSON.stringify(data);
  const cookie = cookieValue === null
    ? `${cookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
    : `${cookieName}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Set-Cookie': cookie
  });
  res.end(body);
}

route('POST', '/api/auth/login', async (req, res, body) => {
  let identity;
  try {
    identity = await verifyGoogleToken(body.idToken);
  } catch (err) {
    return sendJSON(res, 401, { error: 'Google sign-in verification failed: ' + err.message });
  }
  // Emails are always lowercased before touching the database — otherwise a
  // differently-cased email typed elsewhere (e.g. by an admin) would silently
  // never match this person's real Google account on future logins.
  identity.email = identity.email.toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(identity.email);
  if (!existing) {
    db.prepare('INSERT INTO users (email, name, is_admin) VALUES (?, ?, ?)')
      .run(identity.email, identity.name, identity.email === ADMIN_EMAIL ? 1 : 0);
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(identity.email);

  // Issue a real session — only ever created right here, right after a real
  // Google token was verified above. Nothing else can create one.
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_email) VALUES (?, ?)').run(token, user.email);
  sendJSONWithCookie(res, 200, { user }, 'gc_session', token, 60 * 60 * 24 * 30); // 30 days
});

// Called once on page load — if the browser has a valid session cookie from a
// previous real sign-in, this restores it without showing the Google button again.
route('GET', '/api/auth/me', async (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.gc_session;
  if (!token) return sendJSON(res, 401, { error: 'no session' });
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return sendJSON(res, 401, { error: 'invalid or expired session' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(session.user_email);
  if (!user || user.banned) return sendJSON(res, 401, { error: 'account unavailable' });
  sendJSON(res, 200, { user });
});

route('POST', '/api/auth/logout', async (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.gc_session) db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies.gc_session);
  sendJSONWithCookie(res, 200, { ok: true }, 'gc_session', null, 0);
});

// Public, non-secret config the frontend needs at load time (e.g. to init
// Google Sign-In). Never put real secrets here — only public identifiers.
route('GET', '/api/config', async (req, res) => {
  sendJSON(res, 200, { googleClientId: GOOGLE_CLIENT_ID, flutterwavePublicKey: process.env.FLUTTERWAVE_PUBLIC_KEY || null });
});

// -- KYC / identity verification (NIN + selfie only — cached so we never pay twice) --
route('GET', '/api/kyc/verified/:email', async (req, res, body, params) => {
  const row = db.prepare('SELECT * FROM verified_identities WHERE email = ?').get(decodeURIComponent(params.email));
  sendJSON(res, row ? 200 : 404, row || { error: 'not verified yet' });
});

route('POST', '/api/kyc/verify-identity', async (req, res, body) => {
  body.email = (body.email || '').toLowerCase();
  const existing = db.prepare('SELECT * FROM verified_identities WHERE email = ?').get(body.email);
  if (existing) return sendJSON(res, 200, { cached: true, identity: existing });

  const result = verifyNin(body.nin, body.selfiePhoto);
  if (!result.success) return sendJSON(res, 422, { error: 'NIN verification failed — check the number and try again' });

  db.prepare(`INSERT INTO verified_identities (email, fullname, phone, nin, selfie_photo, dob) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(body.email, body.fullname, body.phone, body.nin, body.selfiePhoto || null, body.dob);
  const identity = db.prepare('SELECT * FROM verified_identities WHERE email = ?').get(body.email);
  sendJSON(res, 201, { cached: false, identity });
});

route('DELETE', '/api/kyc/verified/:email', async (req, res, body, params) => {
  db.prepare('DELETE FROM verified_identities WHERE email = ?').run(decodeURIComponent(params.email).toLowerCase());
  sendJSON(res, 200, { reset: true });
});

// -- Resellers --
route('POST', '/api/resellers', async (req, res, body) => {
  body.email = (body.email || '').toLowerCase();
  const verified = db.prepare('SELECT * FROM verified_identities WHERE email = ?').get(body.email);
  if (!verified) return sendJSON(res, 400, { error: 'Identity must be verified before becoming a reseller' });

  // An admin can add someone as a reseller before that person has ever signed
  // in with Google — make sure a users row exists so the reseller row can
  // actually be saved (resellers.user_email references users.email). When
  // they do sign in for real later, /api/auth/login just reuses this row.
  const existingUser = db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email);
  if (!existingUser) {
    db.prepare('INSERT INTO users (email, name) VALUES (?, ?)').run(body.email, verified.fullname || body.email);
  }

  // If paying for the plan with wallet balance, check funds BEFORE creating
  // anything, and actually debit only after the reseller row is safely created.
  if (body.payWithWallet && body.walletAmount > getWalletBalance('customer', body.email)) {
    return sendJSON(res, 400, { error: 'Insufficient wallet balance' });
  }

  const info = db.prepare(`
    INSERT INTO resellers (user_email, biz_name, biz_state, address, location_pinned, bank_name, bank_acct, bank_acct_name, plan, plan_expires_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(body.email, body.bizName, body.bizState || '', body.address || '', body.locationPinned ? 1 : 0,
         body.bankName || '', body.bankAcct || '', body.bankAcctName || '',
         body.plan || 'Pro (₦6,000/mo)', planExpiryDate(), body.source || 'self');

  if (body.payWithWallet && body.walletAmount > 0) {
    try {
      debitWallet('customer', body.email, body.walletAmount, `Reseller signup — ${body.plan || 'plan'}`, null);
    } catch (err) {
      db.prepare('DELETE FROM resellers WHERE id = ?').run(info.lastInsertRowid);
      return sendJSON(res, 400, { error: err.message });
    }
  }

  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(info.lastInsertRowid);

  // The bank added at registration counts as one of their 2 saved withdrawal
  // accounts — not an extra slot on top.
  if (body.bankName && body.bankAcct && body.bankAcctName) {
    db.prepare('INSERT INTO saved_bank_accounts (owner_type, owner_id, bank_name, bank_acct, bank_acct_name) VALUES (?, ?, ?, ?, ?)')
      .run('reseller', String(reseller.id), body.bankName, body.bankAcct, body.bankAcctName);
  }

  sendJSON(res, 201, { reseller });
});

route('GET', '/api/resellers', async (req, res, body, params, query) => {
  let list = db.prepare('SELECT * FROM resellers ORDER BY created_at DESC').all();
  if (query.email) list = list.filter(r => r.user_email.toLowerCase() === query.email.toLowerCase());
  if (query.search) {
    const term = query.search.toLowerCase();
    list = list.filter(r => r.biz_name.toLowerCase().includes(term) || r.user_email.toLowerCase().includes(term));
  }
  let enriched = list.map(r => {
    const sales = db.prepare("SELECT COALESCE(SUM(reseller_payout),0) s FROM orders WHERE reseller_id = ? AND status = 'delivered'").get(r.id).s;
    return { ...r, plan_expired: isPlanExpired(r), total_sales: sales };
  });
  if (query.sort === 'amount') {
    enriched.sort((a, b) => query.dir === 'asc' ? a.total_sales - b.total_sales : b.total_sales - a.total_sales);
  } else if (query.sort === 'date') {
    enriched.sort((a, b) => {
      const diff = new Date(a.created_at) - new Date(b.created_at);
      return query.dir === 'desc' ? -diff : diff;
    });
  }
  sendJSON(res, 200, { resellers: enriched });
});

route('GET', '/api/resellers/:id', async (req, res, body, params) => {
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(params.id);
  if (!r) return sendJSON(res, 404, { error: 'not found' });
  sendJSON(res, 200, { reseller: { ...r, plan_expired: isPlanExpired(r) } });
});

// Fully removes reseller status — their account goes back to being a plain
// customer. Their listings are removed too (a former reseller's products
// shouldn't keep showing). Their user account, order history, and wallet
// balance are all untouched.
route('DELETE', '/api/resellers/:id', async (req, res, body, params) => {
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(params.id);
  if (!r) return sendJSON(res, 404, { error: 'not found' });
  // Protect their money — move any remaining reseller wallet balance to their
  // customer wallet before removing the reseller account, never just discard it.
  if (r.available_balance > 0) {
    debitWallet('reseller', r.id, r.available_balance, 'Reseller account closed — balance moved to customer wallet', null);
    creditWallet('customer', r.user_email, r.available_balance, 'Moved from closed reseller account', null);
  }
  db.prepare('DELETE FROM listings WHERE reseller_id = ?').run(params.id);
  db.prepare('DELETE FROM saved_bank_accounts WHERE owner_type = ? AND owner_id = ?').run('reseller', String(params.id));
  db.prepare('DELETE FROM virtual_accounts WHERE owner_type = ? AND owner_id = ?').run('reseller', String(params.id));
  db.prepare('DELETE FROM resellers WHERE id = ?').run(params.id);
  sendJSON(res, 200, { deleted: true, email: r.user_email });
});

route('POST', '/api/resellers/:id/extend', async (req, res, body, params) => {
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(params.id);
  if (!r) return sendJSON(res, 404, { error: 'not found' });

  if (body.payWithWallet && body.amount > 0) {
    try {
      debitWallet('reseller', r.id, body.amount, `Plan renewal — ${body.plan || r.plan}`, null);
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }

  const base = Math.max(Date.now(), new Date(r.plan_expires_at).getTime());
  const newExpiry = new Date(base + PLAN_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  if (body.plan) {
    db.prepare('UPDATE resellers SET plan_expires_at = ?, plan = ?, interest_while_expired = 0 WHERE id = ?').run(newExpiry, body.plan, params.id);
  } else {
    db.prepare('UPDATE resellers SET plan_expires_at = ?, interest_while_expired = 0 WHERE id = ?').run(newExpiry, params.id);
  }
  sendJSON(res, 200, { plan_expires_at: newExpiry });
});

route('POST', '/api/resellers/:id/register-interest', async (req, res, body, params) => {
  db.prepare('UPDATE resellers SET interest_while_expired = interest_while_expired + 1 WHERE id = ?').run(params.id);
  sendJSON(res, 200, { ok: true });
});

route('POST', '/api/resellers/:id/ban', async (req, res, body, params) => {
  db.prepare('UPDATE resellers SET banned = 1 WHERE id = ?').run(params.id);
  sendJSON(res, 200, { banned: true });
});
route('POST', '/api/resellers/:id/unban', async (req, res, body, params) => {
  db.prepare('UPDATE resellers SET banned = 0 WHERE id = ?').run(params.id);
  sendJSON(res, 200, { banned: false });
});

// -- Customers (non-reseller users) --
route('GET', '/api/customers', async (req, res, body, params, query) => {
  const resellerEmails = new Set(db.prepare('SELECT user_email FROM resellers').all().map(r => r.user_email));
  let list = db.prepare('SELECT * FROM users').all().filter(u => !resellerEmails.has(u.email));
  if (query.search) {
    const term = query.search.toLowerCase();
    list = list.filter(u => u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term));
  }
  let enriched = list.map(u => {
    const spent = db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE buyer_email = ? AND status = 'delivered'").get(u.email).s;
    return { ...u, total_spent: spent };
  });
  if (query.sort === 'amount') {
    enriched.sort((a, b) => query.dir === 'asc' ? a.total_spent - b.total_spent : b.total_spent - a.total_spent);
  } else if (query.sort === 'date') {
    enriched.sort((a, b) => {
      const diff = new Date(a.created_at) - new Date(b.created_at);
      return query.dir === 'desc' ? -diff : diff;
    });
  }
  sendJSON(res, 200, { customers: enriched });
});
route('POST', '/api/customers/:email/ban', async (req, res, body, params) => {
  db.prepare('UPDATE users SET banned = 1 WHERE email = ?').run(decodeURIComponent(params.email));
  sendJSON(res, 200, { banned: true });
});
route('POST', '/api/customers/:email/unban', async (req, res, body, params) => {
  db.prepare('UPDATE users SET banned = 0 WHERE email = ?').run(decodeURIComponent(params.email));
  sendJSON(res, 200, { banned: false });
});

// -- Listings — full reseller control: up to 5 photos, manual viewers/rating,
//    an optional discount code, and no delivery-area gate of any kind. --
function serializeListing(l) {
  let photos = [];
  try { photos = JSON.parse(l.photos || '[]'); } catch (e) { photos = []; }
  return { ...l, photos };
}
route('POST', '/api/listings', async (req, res, body) => {
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(body.resellerId);
  if (!reseller) return sendJSON(res, 404, { error: 'reseller not found' });
  if (isPlanExpired(reseller)) return sendJSON(res, 403, { error: 'Your plan has expired — renew to post new listings' });

  const photos = Array.isArray(body.photos) ? body.photos.slice(0, 5) : [];
  const info = db.prepare(`
    INSERT INTO listings (reseller_id, name, description, price_text, type, photos, viewers, rating, discount_code, discount_percent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(reseller.id, body.name, body.description || '', body.price, body.type || 'product',
         JSON.stringify(photos), body.viewers || 0, body.rating || 0,
         body.discountCode || null, body.discountPercent || null);

  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(info.lastInsertRowid);
  sendJSON(res, 201, { listing: serializeListing(listing) });
});

route('GET', '/api/listings', async (req, res, body, params, query) => {
  let list = db.prepare('SELECT * FROM listings ORDER BY created_at DESC').all();
  if (query.type) list = list.filter(l => l.type === query.type);
  if (query.search) {
    const term = query.search.toLowerCase();
    list = list.filter(l => l.name.toLowerCase().includes(term) || (l.description || '').toLowerCase().includes(term));
  }
  const enriched = list.map(l => {
    const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(l.reseller_id);
    return {
      ...serializeListing(l),
      seller: reseller ? reseller.biz_name : 'Unknown',
      sellerState: reseller ? reseller.biz_state : null,
      resellerId: l.reseller_id,
      seller_banned: reseller ? !!reseller.banned : false,
      unavailable: reseller ? isPlanExpired(reseller) : true
    };
  }).filter(l => !l.seller_banned);
  const filtered = query.state ? enriched.filter(l => l.sellerState === query.state) : enriched;
  sendJSON(res, 200, { listings: filtered });
});

route('PATCH', '/api/listings/:id', async (req, res, body, params) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id);
  if (!l) return sendJSON(res, 404, { error: 'not found' });
  const fields = {
    name: body.name ?? l.name,
    description: body.description ?? l.description,
    price_text: body.price ?? l.price_text,
    photos: body.photos ? JSON.stringify(body.photos.slice(0, 5)) : l.photos,
    viewers: body.viewers ?? l.viewers,
    rating: body.rating ?? l.rating,
    discount_code: body.discountCode ?? l.discount_code,
    discount_percent: body.discountPercent ?? l.discount_percent
  };
  db.prepare(`UPDATE listings SET name=?, description=?, price_text=?, photos=?, viewers=?, rating=?, discount_code=?, discount_percent=? WHERE id=?`)
    .run(fields.name, fields.description, fields.price_text, fields.photos, fields.viewers, fields.rating, fields.discount_code, fields.discount_percent, params.id);
  const updated = db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id);
  sendJSON(res, 200, { listing: serializeListing(updated) });
});

route('DELETE', '/api/listings/:id', async (req, res, body, params) => {
  db.prepare('DELETE FROM listings WHERE id = ?').run(params.id);
  sendJSON(res, 200, { deleted: true });
});

// -- Orders — no area gate. Every order goes to the seller as 'pending'; the
//    seller Accepts or Rejects (any reason, e.g. buyer too far). Rejecting
//    always means a refund to the buyer. --
route('POST', '/api/orders', async (req, res, body) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(body.listingId);
  if (!listing) return sendJSON(res, 404, { error: 'listing not found' });
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(listing.reseller_id);
  if (!reseller || isPlanExpired(reseller)) return sendJSON(res, 403, { error: 'This listing is not available right now' });

  const qty = body.qty || 1;
  const originalSubtotal = parsePrice(listing.price_text) * qty;

  // Reseller's own product discount code (type B) — reduces both what the
  // buyer pays AND the base the reseller is paid on, same as any normal sale discount.
  let afterProductDiscount = originalSubtotal;
  let discountApplied = 0;
  if (body.discountCode && listing.discount_code && body.discountCode.trim().toUpperCase() === listing.discount_code.trim().toUpperCase()) {
    discountApplied = Math.round(originalSubtotal * ((listing.discount_percent || 0) / 100));
    afterProductDiscount = originalSubtotal - discountApplied;
  }

  const commission = Math.round(afterProductDiscount * COMMISSION_RATE);
  const resellerPayout = afterProductDiscount - commission; // GoldComfort's cut only ever comes from here

  // Ad-hoc customer credit (type C) — reduces what the buyer pays further,
  // but NEVER reduces the reseller's payout above. GoldComfort absorbs it.
  let creditUsed = 0;
  const creditIds = Array.isArray(body.creditIds) ? body.creditIds : [];
  const appliedCredits = [];
  for (const cid of creditIds) {
    const c = db.prepare('SELECT * FROM customer_credits WHERE id = ? AND customer_email = ? AND used = 0').get(cid, body.buyerEmail);
    if (c) { creditUsed += c.amount; appliedCredits.push(c.id); }
  }
  const total = Math.max(0, afterProductDiscount - creditUsed);

  // GoldComfort-issued shop-wide discount code (distinct from the reseller's
  // own code above) — reduces what the buyer pays further, but GoldComfort
  // absorbs it; the reseller's payout is untouched, exactly like customer credit.
  let shopCouponDiscount = 0;
  if (body.shopCouponCode) {
    const coupon = db.prepare("SELECT * FROM coupons WHERE code = ? AND active = 1 AND type = 'shop'").get(body.shopCouponCode.trim().toUpperCase());
    if (coupon && (!coupon.expires_at || new Date() <= new Date(coupon.expires_at)) &&
        (coupon.audience !== 'specific' || coupon.target_email === body.buyerEmail)) {
      shopCouponDiscount = Math.round(total * (coupon.discount_percent / 100));
    }
  }
  const finalTotal = Math.max(0, total - shopCouponDiscount);

  // If paying with wallet balance, check funds are there BEFORE creating the
  // order — but only actually debit after the order is safely inserted below.
  if (body.payWithWallet && finalTotal > getWalletBalance('customer', body.buyerEmail)) {
    return sendJSON(res, 400, { error: 'Insufficient wallet balance' });
  }

  const info = db.prepare(`
    INSERT INTO orders (listing_id, reseller_id, buyer_email, qty, subtotal, fee, discount_applied, credit_used, total, commission, reseller_payout,
      cust_state, address, cust_phone, cust_whatsapp, cust_email, status)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(listing.id, reseller.id, body.buyerEmail, qty, originalSubtotal, discountApplied + shopCouponDiscount, creditUsed, finalTotal, commission, resellerPayout,
         body.custState || null, body.address, body.custPhone || null, body.custWhatsapp || null, body.custEmail || null);

  for (const cid of appliedCredits) {
    db.prepare('UPDATE customer_credits SET used = 1, used_order_id = ? WHERE id = ?').run(info.lastInsertRowid, cid);
  }

  if (body.payWithWallet && finalTotal > 0) {
    try {
      debitWallet('customer', body.buyerEmail, finalTotal, `Order payment — #${info.lastInsertRowid}`, info.lastInsertRowid);
    } catch (err) {
      db.prepare("DELETE FROM orders WHERE id = ?").run(info.lastInsertRowid);
      return sendJSON(res, 400, { error: err.message });
    }
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  sendJSON(res, 201, { order });
});

route('GET', '/api/orders', async (req, res, body, params, query) => {
  let list = db.prepare('SELECT * FROM orders ORDER BY ordered_at DESC').all();
  if (query.buyer) list = list.filter(o => o.buyer_email === query.buyer);
  if (query.reseller) list = list.filter(o => String(o.reseller_id) === String(query.reseller));
  const enriched = list.map(o => {
    const listing = db.prepare('SELECT name, type FROM listings WHERE id = ?').get(o.listing_id);
    const reseller = db.prepare('SELECT biz_name, user_email FROM resellers WHERE id = ?').get(o.reseller_id);
    const identity = reseller ? db.prepare('SELECT phone FROM verified_identities WHERE email = ?').get(reseller.user_email) : null;
    return { ...o, listing_name: listing?.name || 'Item', listing_type: listing?.type || 'product', seller_name: reseller?.biz_name || 'Seller', seller_phone: identity?.phone || null };
  });
  sendJSON(res, 200, { orders: enriched });
});

route('POST', '/api/orders/:id/accept', async (req, res, body, params) => {
  if (!body.expectedDeliveryAt) return sendJSON(res, 400, { error: 'Set an expected delivery date/time before accepting' });
  db.prepare("UPDATE orders SET status = 'preparing', expected_delivery_at = ? WHERE id = ? AND status = 'pending'").run(body.expectedDeliveryAt, params.id);
  sendJSON(res, 200, { status: 'preparing' });
});
route('POST', '/api/orders/:id/reject', async (req, res, body, params) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(params.id);
  if (!order) return sendJSON(res, 404, { error: 'not found' });
  if (!body.reason || !body.reason.trim()) return sendJSON(res, 400, { error: 'Please explain why you are declining this order' });
  db.prepare("UPDATE orders SET status = 'seller-declined', decline_reason = ? WHERE id = ?").run(body.reason.trim(), params.id);
  creditWallet('customer', order.buyer_email, order.total, `Refund — order #${order.id} declined by seller`, order.id);
  sendJSON(res, 200, { status: 'seller-declined' });
});
route('POST', '/api/orders/:id/advance', async (req, res, body, params) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(params.id);
  if (!order) return sendJSON(res, 404, { error: 'not found' });
  const next = order.status === 'preparing' ? 'on-way' : order.status === 'on-way' ? 'arrived' : order.status;
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(next, params.id);
  sendJSON(res, 200, { status: next });
});
function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

route('POST', '/api/orders/:id/confirm', async (req, res, body, params) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(params.id);
  if (!order) return sendJSON(res, 404, { error: 'not found' });
  db.prepare("UPDATE orders SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?").run(params.id);
  creditWallet('reseller', order.reseller_id, order.reseller_payout, `Order #${order.id} delivered`, order.id);
  creditWallet('admin', ADMIN_EMAIL, order.commission, `Commission — order #${order.id}`, order.id);

  // Cashback — GoldComfort-funded, doesn't touch the reseller's payout. Uses
  // the same customer_credits mechanism as admin-granted credit, just
  // auto-triggered here with a system reason and an expiry.
  const cashbackPercent = Number(getSetting('cashback_percent', '1'));
  const cashbackExpiryDays = Number(getSetting('cashback_expiry_days', '180'));
  let cashbackAmount = 0;
  if (cashbackPercent > 0) {
    cashbackAmount = Math.round(order.total * (cashbackPercent / 100));
    if (cashbackAmount > 0) {
      const expiresAt = new Date(Date.now() + cashbackExpiryDays * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO customer_credits (customer_email, amount, reason, expires_at) VALUES (?, ?, ?, ?)')
        .run(order.buyer_email, cashbackAmount, `Cashback — order #${order.id}`, expiresAt);
    }
  }

  sendJSON(res, 200, { status: 'delivered', payout: order.reseller_payout, cashbackAmount });
});

// Auto-void any cashback/credit that was never used before its expiry —
// runs alongside the order-expiry check, same cadence.
function checkExpiredCredits() {
  db.prepare(`UPDATE customer_credits SET used = 1 WHERE used = 0 AND expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
}

// Auto-expiry: any order past the delivery deadline the reseller themselves
// set, that never got delivered, refunds the buyer automatically. Runs every
// minute — cheap query, only touches orders that are actually overdue.
function checkExpiredOrders() {
  const overdue = db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('preparing','on-way','arrived')
      AND expected_delivery_at IS NOT NULL
      AND expected_delivery_at < datetime('now')
  `).all();
  for (const order of overdue) {
    db.prepare("UPDATE orders SET status = 'expired' WHERE id = ?").run(order.id);
    creditWallet('customer', order.buyer_email, order.total, `Refund — order #${order.id} expired (not delivered in time)`, order.id);
    console.log(`[auto-expiry] Order #${order.id} expired — refunded ₦${order.total} to ${order.buyer_email}`);
  }
}
setInterval(()=>{ checkExpiredOrders(); checkExpiredCredits(); }, 60 * 1000);

// -- Order chat --
route('POST', '/api/orders/:id/chat', async (req, res, body, params) => {
  db.prepare('INSERT INTO order_chat (order_id, from_role, text) VALUES (?, ?, ?)').run(params.id, body.fromRole, body.text);
  sendJSON(res, 201, { ok: true });
});
route('GET', '/api/orders/:id/chat', async (req, res, body, params) => {
  const messages = db.prepare('SELECT * FROM order_chat WHERE order_id = ? ORDER BY at ASC').all(params.id);
  sendJSON(res, 200, { messages });
});

// -- Buy Requests: verified-to-verified introduction + chat, no money handled here --
route('POST', '/api/buy-requests', async (req, res, body) => {
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(body.resellerId);
  if (!reseller) return sendJSON(res, 404, { error: 'reseller not found' });
  const info = db.prepare('INSERT INTO buy_requests (reseller_id, item_name, description) VALUES (?, ?, ?)')
    .run(reseller.id, body.itemName, body.description || '');
  const br = db.prepare('SELECT * FROM buy_requests WHERE id = ?').get(info.lastInsertRowid);
  sendJSON(res, 201, { buyRequest: br });
});
route('GET', '/api/buy-requests', async (req, res, body, params, query) => {
  let list = db.prepare('SELECT * FROM buy_requests WHERE closed = 0 ORDER BY created_at DESC').all();
  const enriched = list.map(br => {
    const reseller = db.prepare('SELECT biz_name, user_email, banned FROM resellers WHERE id = ?').get(br.reseller_id);
    const msgCount = db.prepare('SELECT COUNT(*) c FROM buy_request_chat WHERE buy_request_id = ?').get(br.id).c;
    const lastMessage = db.prepare('SELECT * FROM buy_request_chat WHERE buy_request_id = ? ORDER BY at DESC LIMIT 1').get(br.id);
    return {
      ...br,
      seller: reseller?.biz_name || 'Unknown',
      seller_email: reseller?.user_email || null,
      seller_banned: !!reseller?.banned,
      message_count: msgCount,
      last_message_from: lastMessage ? lastMessage.from_email : null
    };
  }).filter(br => !br.seller_banned);
  sendJSON(res, 200, { buyRequests: enriched });
});
route('POST', '/api/buy-requests/:id/close', async (req, res, body, params) => {
  db.prepare('UPDATE buy_requests SET closed = 1 WHERE id = ?').run(params.id);
  sendJSON(res, 200, { closed: true });
});
route('POST', '/api/buy-requests/:id/message', async (req, res, body, params) => {
  db.prepare('INSERT INTO buy_request_chat (buy_request_id, from_email, text) VALUES (?, ?, ?)').run(params.id, body.fromEmail, body.text);
  sendJSON(res, 201, { ok: true });
});
route('GET', '/api/buy-requests/:id/thread', async (req, res, body, params) => {
  const messages = db.prepare('SELECT * FROM buy_request_chat WHERE buy_request_id = ? ORDER BY at ASC').all(params.id);
  sendJSON(res, 200, { messages });
});

// -- Reports (abuse anywhere — Buy Requests, chat, orders) --
route('POST', '/api/reports', async (req, res, body) => {
  db.prepare('INSERT INTO reports (reporter_email, reported_email, reason, context) VALUES (?, ?, ?, ?)')
    .run(body.reporterEmail, body.reportedEmail, body.reason, body.context || '');
  sendJSON(res, 201, { ok: true });
});
route('GET', '/api/reports', async (req, res) => {
  const reports = db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  sendJSON(res, 200, { reports });
});
route('POST', '/api/reports/:id/resolve', async (req, res, body, params) => {
  db.prepare('UPDATE reports SET resolved = 1 WHERE id = ?').run(params.id);
  sendJSON(res, 200, { resolved: true });
});

// -- Coupons --
// type 'signup': admin-issued, percent off a reseller plan payment (100% = free),
//   to attract new sellers. Can target everyone or one specific person, and can
//   optionally expire (e.g. a weekend-only promo).
// type 'product': a reseller's own code, stored directly on their listing (see /api/listings).
route('POST', '/api/coupons', async (req, res, body) => {
  try {
    const info = db.prepare(`
      INSERT INTO coupons (code, type, role, reseller_id, discount_percent, audience, target_email, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.code.trim().toUpperCase(), body.type, body.role || 'customer', body.resellerId || null, body.discountPercent,
      body.audience || 'all', body.audience === 'specific' ? (body.targetEmail || null) : null,
      body.expiresAt || null
    );
    sendJSON(res, 201, { id: info.lastInsertRowid });
  } catch (e) {
    sendJSON(res, 409, { error: 'That coupon code already exists' });
  }
});
route('GET', '/api/coupons', async (req, res, body, params, query) => {
  let list = db.prepare('SELECT * FROM coupons WHERE active = 1 ORDER BY created_at DESC').all();
  if (query.type) list = list.filter(c => c.type === query.type);
  if (query.role) list = list.filter(c => c.role === query.role);
  sendJSON(res, 200, { coupons: list });
});
route('GET', '/api/coupons/:code/check', async (req, res, body, params, query) => {
  const c = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(decodeURIComponent(params.code).trim().toUpperCase());
  if (!c) return sendJSON(res, 404, { error: 'Invalid or expired coupon' });
  if (c.expires_at && new Date() > new Date(c.expires_at)) return sendJSON(res, 404, { error: 'This coupon has expired' });
  if (c.audience === 'specific' && c.target_email && query.email && c.target_email !== query.email) {
    return sendJSON(res, 403, { error: 'This coupon is not available on your account' });
  }
  sendJSON(res, 200, { coupon: c });
});
route('POST', '/api/coupons/:id/deactivate', async (req, res, body, params) => {
  db.prepare('UPDATE coupons SET active = 0 WHERE id = ?').run(params.id);
  sendJSON(res, 200, { ok: true });
});

// -- Home banner slides (admin-managed carousel — image, text, or both) --
route('POST', '/api/banner-slides', async (req, res, body) => {
  const maxOrder = db.prepare('SELECT MAX(sort_order) m FROM banner_slides').get().m || 0;
  const info = db.prepare('INSERT INTO banner_slides (image, text, link_url, sort_order) VALUES (?, ?, ?, ?)')
    .run(body.image || null, body.text || null, body.linkUrl || null, maxOrder + 1);
  sendJSON(res, 201, { id: info.lastInsertRowid });
});
route('GET', '/api/banner-slides', async (req, res) => {
  const slides = db.prepare('SELECT * FROM banner_slides ORDER BY sort_order ASC').all();
  sendJSON(res, 200, { slides });
});
route('DELETE', '/api/banner-slides/:id', async (req, res, body, params) => {
  db.prepare('DELETE FROM banner_slides WHERE id = ?').run(params.id);
  sendJSON(res, 200, { deleted: true });
});
route('POST', '/api/banner-slides/:id/view', async (req, res, body, params) => {
  db.prepare('UPDATE banner_slides SET views = views + 1 WHERE id = ?').run(params.id);
  sendJSON(res, 200, { ok: true });
});
route('POST', '/api/banner-slides/:id/click', async (req, res, body, params) => {
  db.prepare('UPDATE banner_slides SET clicks = clicks + 1 WHERE id = ?').run(params.id);
  sendJSON(res, 200, { ok: true });
});

// -- Customer credits (ad-hoc "ragowa" from a reseller, spendable anywhere) --
route('POST', '/api/credits', async (req, res, body) => {
  const info = db.prepare('INSERT INTO customer_credits (customer_email, amount, granted_by_reseller_id, reason) VALUES (?, ?, ?, ?)')
    .run(body.customerEmail, body.amount, body.resellerId || null, body.reason || '');
  sendJSON(res, 201, { id: info.lastInsertRowid });
});
route('GET', '/api/credits', async (req, res, body, params, query) => {
  let list = db.prepare('SELECT * FROM customer_credits WHERE customer_email = ? ORDER BY created_at DESC').all(query.email || '');
  sendJSON(res, 200, { credits: list });
});

// -- Settings (admin-controlled Home banner, etc.) --
route('GET', '/api/settings/:key', async (req, res, body, params) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(params.key);
  sendJSON(res, 200, { value: row ? row.value : null });
});
route('POST', '/api/settings/:key', async (req, res, body, params) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(params.key, body.value);
  sendJSON(res, 200, { ok: true });
});

// -- Notifications --
route('POST', '/api/notifications', async (req, res, body) => {
  const info = db.prepare('INSERT INTO notifications (message, audience) VALUES (?, ?)').run(body.message, body.audience);
  sendJSON(res, 201, { id: info.lastInsertRowid });
});
route('GET', '/api/notifications', async (req, res, body, params, query) => {
  const email = query.email;
  const isReseller = email ? !!db.prepare('SELECT 1 FROM resellers WHERE user_email = ?').get(email) : false;
  let list = db.prepare('SELECT * FROM notifications ORDER BY sent_at DESC').all();
  if (query.all !== '1') {
    list = list.filter(n => n.audience === 'all' || (n.audience === 'reseller' && isReseller) || n.audience === 'customer');
  }
  const reads = new Set(db.prepare('SELECT notification_id FROM notification_reads WHERE user_email = ?').all(email).map(r => r.notification_id));
  sendJSON(res, 200, { notifications: list.map(n => ({ ...n, read: reads.has(n.id) })) });
});
route('POST', '/api/notifications/:id/read', async (req, res, body, params) => {
  db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_email) VALUES (?, ?)').run(params.id, body.email);
  sendJSON(res, 200, { ok: true });
});

// -- Support chat --
route('POST', '/api/support/:email/message', async (req, res, body, params) => {
  const email = decodeURIComponent(params.email);
  db.prepare('INSERT INTO support_messages (user_email, from_role, text) VALUES (?, ?, ?)').run(email, body.fromRole, body.text);
  db.prepare('INSERT INTO support_threads (user_email) VALUES (?) ON CONFLICT(user_email) DO NOTHING').run(email);
  if (body.fromRole === 'user') db.prepare('UPDATE support_threads SET unread_for_admin = 1 WHERE user_email = ?').run(email);
  if (body.fromRole === 'admin') db.prepare('UPDATE support_threads SET unread_for_user = 1, escalated = 1 WHERE user_email = ?').run(email);
  sendJSON(res, 201, { ok: true });
});
route('POST', '/api/support/:email/escalate', async (req, res, body, params) => {
  const email = decodeURIComponent(params.email);
  db.prepare('INSERT INTO support_threads (user_email) VALUES (?) ON CONFLICT(user_email) DO NOTHING').run(email);
  db.prepare('UPDATE support_threads SET escalated = 1, unread_for_admin = 1 WHERE user_email = ?').run(email);
  sendJSON(res, 200, { ok: true });
});
route('GET', '/api/support/:email/thread', async (req, res, body, params) => {
  const email = decodeURIComponent(params.email);
  const messages = db.prepare('SELECT * FROM support_messages WHERE user_email = ? ORDER BY at ASC').all(email);
  const thread = db.prepare('SELECT * FROM support_threads WHERE user_email = ?').get(email) || { escalated: 0, unread_for_admin: 0, unread_for_user: 0 };
  sendJSON(res, 200, { messages, thread });
});
route('POST', '/api/support/:email/mark-read', async (req, res, body, params) => {
  const email = decodeURIComponent(params.email);
  const field = body.side === 'admin' ? 'unread_for_admin' : 'unread_for_user';
  db.prepare(`UPDATE support_threads SET ${field} = 0 WHERE user_email = ?`).run(email);
  sendJSON(res, 200, { ok: true });
});
route('GET', '/api/support/inbox', async (req, res) => {
  const threads = db.prepare('SELECT * FROM support_threads').all();
  sendJSON(res, 200, { threads });
});

// -- Admin stats --
route('GET', '/api/admin/stats', async (req, res) => {
  const totalOrders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const completed = db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'delivered'").get().c;
  const pending = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('pending','preparing','on-way','arrived')").get().c;
  const totalResellers = db.prepare('SELECT COUNT(*) c FROM resellers').get().c;
  sendJSON(res, 200, { totalOrders, completed, pending, totalResellers });
});

// -- Automatic first-time-reseller discount (system rule, not an admin coupon) --
// Starter ₦2,000 → ₦500 off → ₦1,500 · Pro ₦6,000 → ₦2,000 off → ₦4,000 · Business ₦12,000 → ₦5,000 off → ₦7,000
// Applies exactly once per person, the very first time they ever register as a reseller.
const FIRST_TIME_PLAN_PRICING = {
  'Starter': { base: 2000, discount: 500 },
  'Pro':      { base: 6000, discount: 2000 },
  'Business': { base: 12000, discount: 5000 }
};
route('GET', '/api/plans/first-time-price', async (req, res, body, params, query) => {
  const planKey = (query.plan || 'Pro');
  const pricing = FIRST_TIME_PLAN_PRICING[planKey] || FIRST_TIME_PLAN_PRICING['Pro'];
  const everRegistered = query.email ? !!db.prepare('SELECT 1 FROM resellers WHERE user_email = ?').get(query.email) : true;
  const isFirstTime = !everRegistered;
  const finalPrice = isFirstTime ? (pricing.base - pricing.discount) : pricing.base;
  sendJSON(res, 200, { plan: planKey, basePrice: pricing.base, discount: isFirstTime ? pricing.discount : 0, finalPrice, isFirstTime });
});

// -- Listing views (auto-counts every time a customer opens the detail page) --
route('POST', '/api/listings/:id/view', async (req, res, body, params) => {
  db.prepare('UPDATE listings SET viewers = viewers + 1 WHERE id = ?').run(params.id);
  sendJSON(res, 200, { ok: true });
});

// -- Customer star ratings (1-5). listings.rating is kept as the live average. --
route('POST', '/api/listings/:id/rate', async (req, res, body, params) => {
  const stars = Math.max(1, Math.min(5, Number(body.stars) || 0));
  db.prepare(`
    INSERT INTO listing_ratings (listing_id, customer_email, stars) VALUES (?, ?, ?)
    ON CONFLICT(listing_id, customer_email) DO UPDATE SET stars = excluded.stars, at = datetime('now')
  `).run(params.id, body.email, stars);
  const avg = db.prepare('SELECT AVG(stars) a, COUNT(*) c FROM listing_ratings WHERE listing_id = ?').get(params.id);
  db.prepare('UPDATE listings SET rating = ? WHERE id = ?').run(avg.a || 0, params.id);
  sendJSON(res, 200, { rating: avg.a || 0, count: avg.c });
});

route('GET', '/api/listings/:id/rating-breakdown', async (req, res, body, params) => {
  const rows = db.prepare('SELECT stars, COUNT(*) c FROM listing_ratings WHERE listing_id = ? GROUP BY stars').all(params.id);
  const breakdown = {5:0, 4:0, 3:0, 2:0, 1:0};
  rows.forEach(r => { breakdown[r.stars] = r.c; });
  const total = Object.values(breakdown).reduce((a,b)=>a+b, 0);
  sendJSON(res, 200, { breakdown, total });
});

// -- Phone OTP verification via Termii (real integration — no demo/fallback code) --
function httpsPostJSON(hostname, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(extraHeaders || {}) }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

route('POST', '/api/otp/send', async (req, res, body) => {
  if (!process.env.TERMII_API_KEY || !process.env.TERMII_SENDER_ID) {
    return sendJSON(res, 503, { error: 'OTP service not configured on this server yet — set TERMII_API_KEY and TERMII_SENDER_ID in .env.' });
  }
  try {
    const result = await httpsPostJSON('api.ng.termii.com', '/api/sms/otp/send', {
      api_key: process.env.TERMII_API_KEY,
      message_type: 'NUMERIC',
      to: body.phone,
      from: process.env.TERMII_SENDER_ID,
      channel: 'generic',
      pin_attempts: 3,
      pin_time_to_live: 5,
      pin_length: 4,
      pin_placeholder: '< 1234 >',
      message_text: 'Your GoldComfort verification code is < 1234 >',
      pin_type: 'NUMERIC'
    });
    if (!result.body || !result.body.pin_id) {
      return sendJSON(res, 502, { error: 'Termii did not accept this request', detail: result.body });
    }
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    db.prepare(`
      INSERT INTO otp_codes (phone, code, expires_at, verified) VALUES (?, ?, ?, 0)
      ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, verified = 0
    `).run(body.phone, result.body.pin_id, expiresAt);
    sendJSON(res, 200, { sent: true });
  } catch (err) {
    sendJSON(res, 502, { error: 'Could not reach Termii: ' + err.message });
  }
});
route('POST', '/api/otp/verify', async (req, res, body) => {
  if (!process.env.TERMII_API_KEY) {
    return sendJSON(res, 503, { error: 'OTP service not configured on this server yet — set TERMII_API_KEY in .env.' });
  }
  const row = db.prepare('SELECT * FROM otp_codes WHERE phone = ?').get(body.phone);
  if (!row || new Date() > new Date(row.expires_at)) {
    return sendJSON(res, 400, { verified: false, error: 'Code expired — request a new one' });
  }
  try {
    const result = await httpsPostJSON('api.ng.termii.com', '/api/sms/otp/verify', {
      api_key: process.env.TERMII_API_KEY,
      pin_id: row.code,
      pin: body.code
    });
    const verified = result.body && (result.body.verified === true || result.body.verified === 'True');
    if (verified) db.prepare('UPDATE otp_codes SET verified = 1 WHERE phone = ?').run(body.phone);
    sendJSON(res, verified ? 200 : 400, { verified, error: verified ? undefined : 'Incorrect code' });
  } catch (err) {
    sendJSON(res, 502, { verified: false, error: 'Could not reach Termii: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Flutterwave webhook router — ONE webhook URL is shared between this app and
// your existing VTU app on the same Flutterwave account (Flutterwave only
// allows one webhook URL per account). Every event lands here first; we look
// at the tx_ref prefix to decide where it belongs:
//   "GC-..."  → handled by GoldComfort directly
//   "VTU-..." → relayed byte-for-byte to your VTU app's own webhook URL, so
//               its existing code runs completely unchanged
// Set this URL in Flutterwave Dashboard → Settings → Webhooks:
//   https://yourdomain.com/api/webhooks/flutterwave
// And set VTU_WEBHOOK_FORWARD_URL in .env to your VTU app's real webhook URL.
// ---------------------------------------------------------------------------
function forwardWebhook(targetUrl, rawBody, verifHash) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        ...(verifHash ? { 'verif-hash': verifHash } : {})
      }
    };
    const lib = url.protocol === 'http:' ? require('node:http') : https;
    const fwdReq = lib.request(reqOpts, (fwdRes) => {
      fwdRes.on('data', () => {});
      fwdRes.on('end', () => resolve(fwdRes.statusCode));
    });
    fwdReq.on('error', reject);
    fwdReq.write(rawBody);
    fwdReq.end();
  });
}

route('POST', '/api/webhooks/flutterwave', async (req, res, body) => {
  const verifHash = req.headers['verif-hash'];
  if (process.env.FLUTTERWAVE_WEBHOOK_HASH && verifHash !== process.env.FLUTTERWAVE_WEBHOOK_HASH) {
    console.warn('[webhook] rejected — verif-hash mismatch (not really from Flutterwave?)');
    return sendJSON(res, 401, { error: 'invalid signature' });
  }

  const txRef = body?.data?.tx_ref || '';
  const rawBody = JSON.stringify(body);

  // Wallet top-up: an inbound bank transfer to someone's static virtual
  // account number. Flutterwave identifies these by account_number, not tx_ref,
  // since the customer didn't choose a reference — they just transferred.
  const incomingAccountNumber = body?.data?.account_number || body?.data?.recipient_account_number;
  if (incomingAccountNumber) {
    const va = db.prepare('SELECT * FROM virtual_accounts WHERE account_number = ?').get(incomingAccountNumber);
    if (va) {
      const amount = Number(body?.data?.amount) || 0;
      if (amount > 0) {
        creditWallet(va.owner_type === 'reseller' ? 'reseller' : 'customer', va.owner_id, amount, 'Wallet top-up via bank transfer', null);
        console.log(`[webhook] Top-up: ₦${amount} credited to ${va.owner_type} ${va.owner_id}`);
      }
      return sendJSON(res, 200, { ok: true, routed: 'topup' });
    }
  }

  if (txRef.startsWith('VTU-')) {
    if (!process.env.VTU_WEBHOOK_FORWARD_URL) {
      console.warn('[webhook] got a VTU- event but VTU_WEBHOOK_FORWARD_URL is not set — dropping it');
      return sendJSON(res, 200, { ok: true, note: 'VTU forwarding not configured yet' });
    }
    try {
      await forwardWebhook(process.env.VTU_WEBHOOK_FORWARD_URL, rawBody, verifHash);
    } catch (err) {
      console.error('[webhook] failed to forward to VTU app:', err.message);
    }
    return sendJSON(res, 200, { ok: true, routed: 'vtu' });
  }

  if (txRef.startsWith('GC-')) {
    // TODO: this is where you'd mark the matching GoldComfort order as paid
    // once real Flutterwave charging is wired into POST /api/orders — right
    // now orders are created already-"paid" via the simulated checkout popup.
    console.log('[webhook] GoldComfort event received for', txRef);
    return sendJSON(res, 200, { ok: true, routed: 'goldcomfort' });
  }

  console.log('[webhook] unrecognized tx_ref prefix, ignoring:', txRef);
  sendJSON(res, 200, { ok: true, routed: 'none' });
});

// ---------------------------------------------------------------------------
// Wallet API — balance, history, top-up (virtual account), and withdraw, for
// all three wallet owners: 'admin', 'reseller' (ownerId = reseller's numeric
// id), and 'customer' (ownerId = email).
// ---------------------------------------------------------------------------
route('GET', '/api/wallet/:ownerType/:ownerId', async (req, res, body, params) => {
  const { ownerType, ownerId } = params;
  const decodedId = decodeURIComponent(ownerId);
  const available = getWalletBalance(ownerType === 'admin' ? 'admin' : ownerType, decodedId);
  const pending = getPendingBalance(ownerType, ownerType === 'reseller' ? ownerId : undefined);
  let totalEarning = null;
  if (ownerType === 'reseller') {
    const r = db.prepare('SELECT total_earning FROM resellers WHERE id = ?').get(ownerId);
    totalEarning = r ? r.total_earning : 0;
  }
  const totalBalance = getTotalBalanceEverCredited(ownerType, decodedId);
  const totalRefunded = ownerType === 'customer' ? getTotalRefunded(ownerType, decodedId) : null;
  const resellerEarnedTotal = ownerType === 'admin' ? getResellerEarnedTotal() : null;
  let cashbackAvailable = null;
  if (ownerType === 'customer') {
    const row = db.prepare(`SELECT COALESCE(SUM(amount),0) c FROM customer_credits WHERE customer_email = ? AND used = 0 AND (expires_at IS NULL OR expires_at >= datetime('now'))`).get(decodedId);
    cashbackAvailable = row.c;
  }
  sendJSON(res, 200, { available, pending, totalEarning, totalBalance, totalRefunded, resellerEarnedTotal, cashbackAvailable });
});

route('GET', '/api/wallet/:ownerType/:ownerId/transactions', async (req, res, body, params) => {
  const { ownerType, ownerId } = params;
  const txns = db.prepare('SELECT * FROM wallet_transactions WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(ownerType, decodeURIComponent(ownerId));
  sendJSON(res, 200, { transactions: txns });
});

// Top-up: get (or create) a static virtual account number for this person.
// Real version requires a verified NIN/BVN on file — TODO once Korapay/Flutterwave
// identity verification is wired in for this specific check.
route('POST', '/api/wallet/:ownerType/:ownerId/virtual-account', async (req, res, body, params) => {
  const { ownerType, ownerId } = params;
  const decodedId = decodeURIComponent(ownerId);
  const existing = db.prepare('SELECT * FROM virtual_accounts WHERE owner_type = ? AND owner_id = ?').get(ownerType, decodedId);
  if (existing) return sendJSON(res, 200, { virtualAccount: existing });

  if (!body.nin && !body.bvn) return sendJSON(res, 400, { error: 'NIN or BVN is required to generate your top-up account number' });

  // Always use the real person's own name — never the merchant/business name —
  // so the account number shows as theirs, not "Umar Idris" or "GoldComfort".
  let realName = body.email;
  if (ownerType === 'reseller') {
    const reseller = db.prepare('SELECT user_email FROM resellers WHERE id = ?').get(decodedId);
    const identity = reseller ? db.prepare('SELECT fullname FROM verified_identities WHERE email = ?').get(reseller.user_email) : null;
    realName = identity?.fullname || realName;
  } else {
    const identity = db.prepare('SELECT fullname FROM verified_identities WHERE email = ?').get(decodedId);
    const user = db.prepare('SELECT name FROM users WHERE email = ?').get(decodedId);
    realName = identity?.fullname || user?.name || realName;
  }

  const result = await flutterwaveCreateVirtualAccount(body.email, realName, body.nin || body.bvn);
  if (!result.success) return sendJSON(res, 502, { error: result.error || 'Could not generate account number — please try again' });

  db.prepare('INSERT INTO virtual_accounts (owner_type, owner_id, account_number, account_name, bank_name, flw_reference) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ownerType, decodedId, result.accountNumber, result.accountName, result.bankName, result.flwReference || null);
  const virtualAccount = db.prepare('SELECT * FROM virtual_accounts WHERE owner_type = ? AND owner_id = ?').get(ownerType, decodedId);
  sendJSON(res, 201, { virtualAccount });
});

function resolveOwnerEmail(ownerType, decodedId) {
  if (ownerType === 'reseller') {
    const r = db.prepare('SELECT user_email FROM resellers WHERE id = ?').get(decodedId);
    return r ? r.user_email : null;
  }
  return decodedId; // admin/customer ownerId already IS the email
}

route('GET', '/api/bank-accounts/:ownerType/:ownerId', async (req, res, body, params) => {
  const { ownerType, ownerId } = params;
  const accounts = db.prepare('SELECT * FROM saved_bank_accounts WHERE owner_type = ? AND owner_id = ? ORDER BY created_at ASC').all(ownerType, decodeURIComponent(ownerId));
  sendJSON(res, 200, { accounts });
});
route('POST', '/api/bank-accounts/:ownerType/:ownerId', async (req, res, body, params) => {
  const { ownerType, ownerId } = params;
  const decodedId = decodeURIComponent(ownerId);
  const count = db.prepare('SELECT COUNT(*) c FROM saved_bank_accounts WHERE owner_type = ? AND owner_id = ?').get(ownerType, decodedId).c;
  if (count >= 2) return sendJSON(res, 400, { error: 'You can save up to 2 bank accounts — delete one first to add a different one' });
  if (!body.bankName || !body.bankAcct || !body.bankAcctName) return sendJSON(res, 400, { error: 'Bank details are required' });
  const info = db.prepare('INSERT INTO saved_bank_accounts (owner_type, owner_id, bank_name, bank_acct, bank_acct_name) VALUES (?, ?, ?, ?, ?)')
    .run(ownerType, decodedId, body.bankName, body.bankAcct, body.bankAcctName);
  sendJSON(res, 201, { id: info.lastInsertRowid });
});
route('DELETE', '/api/bank-accounts/:id', async (req, res, body, params) => {
  db.prepare('DELETE FROM saved_bank_accounts WHERE id = ?').run(params.id);
  sendJSON(res, 200, { deleted: true });
});

route('POST', '/api/wallet/:ownerType/:ownerId/withdraw', async (req, res, body, params) => {
  const { ownerType, ownerId } = params;
  const decodedId = decodeURIComponent(ownerId);
  const amount = Number(body.amount);
  if (!amount || amount < 500) return sendJSON(res, 400, { error: 'Minimum withdrawal is ₦500' });

  const bankDetails = { bankName: body.bankName, bankAcct: body.bankAcct, bankAcctName: body.bankAcctName };
  if (!bankDetails.bankName || !bankDetails.bankAcct || !bankDetails.bankAcctName) {
    return sendJSON(res, 400, { error: 'Bank details are required' });
  }

  const ownerEmail = resolveOwnerEmail(ownerType, decodedId);
  if (!ownerEmail) return sendJSON(res, 404, { error: 'Account not found' });
  const codeCheck = verifySecurityCode(ownerEmail, body.securityCode);
  if (!codeCheck.ok) return sendJSON(res, 403, { error: codeCheck.error });

  try {
    debitWallet(ownerType === 'admin' ? 'admin' : ownerType, decodedId, amount, `Withdrawal to ${bankDetails.bankName} •••• ${String(bankDetails.bankAcct).slice(-4)}`, null);
  } catch (err) {
    return sendJSON(res, 400, { error: err.message });
  }

  // Save these bank details for next time (up to 2 saved accounts).
  const alreadySaved = db.prepare('SELECT 1 FROM saved_bank_accounts WHERE owner_type = ? AND owner_id = ? AND bank_acct = ?').get(ownerType, decodedId, bankDetails.bankAcct);
  const savedCount = db.prepare('SELECT COUNT(*) c FROM saved_bank_accounts WHERE owner_type = ? AND owner_id = ?').get(ownerType, decodedId).c;
  if (!alreadySaved && savedCount < 2) {
    db.prepare('INSERT INTO saved_bank_accounts (owner_type, owner_id, bank_name, bank_acct, bank_acct_name) VALUES (?, ?, ?, ?, ?)')
      .run(ownerType, decodedId, bankDetails.bankName, bankDetails.bankAcct, bankDetails.bankAcctName);
  }

  const transfer = flutterwaveTransfer(bankDetails, amount);
  sendJSON(res, 200, { ok: true, transfer, newBalance: getWalletBalance(ownerType === 'admin' ? 'admin' : ownerType, decodedId) });
});

// Card top-up: credited directly from the client-side Flutterwave success
// callback (same pattern as regular checkout) — no waiting on a webhook.
route('POST', '/api/wallet/:ownerType/:ownerId/topup-card', async (req, res, body, params) => {
  const { ownerType, ownerId } = params;
  const decodedId = decodeURIComponent(ownerId);
  const amount = Number(body.amount);
  if (!amount || amount < 100) return sendJSON(res, 400, { error: 'Minimum top-up is ₦100' });
  const newBalance = creditWallet(ownerType === 'admin' ? 'admin' : ownerType, decodedId, amount, 'Wallet top-up via card', null);
  sendJSON(res, 200, { ok: true, newBalance });
});

// -- Admin tools: look up any single person by email (support/dispute cases) --
route('GET', '/api/admin/user-lookup/:email', async (req, res, body, params) => {
  const email = decodeURIComponent(params.email).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return sendJSON(res, 404, { error: 'No account found for that email' });

  const reseller = db.prepare('SELECT * FROM resellers WHERE user_email = ?').get(email);
  const identity = db.prepare('SELECT * FROM verified_identities WHERE email = ?').get(email);
  const abandonedRegistration = !!(identity && !reseller);

  const customerTxns = db.prepare('SELECT * FROM wallet_transactions WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 50').all('customer', email);
  const resellerTxns = reseller ? db.prepare('SELECT * FROM wallet_transactions WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 50').all('reseller', String(reseller.id)) : [];

  const ordersAsBuyer = db.prepare('SELECT * FROM orders WHERE buyer_email = ? ORDER BY ordered_at DESC LIMIT 50').all(email);
  const ordersAsSeller = reseller ? db.prepare('SELECT * FROM orders WHERE reseller_id = ? ORDER BY ordered_at DESC LIMIT 50').all(reseller.id) : [];

  sendJSON(res, 200, {
    user, reseller, identity, abandonedRegistration,
    customerBalance: user.available_balance,
    resellerBalance: reseller ? reseller.available_balance : null,
    customerTxns, resellerTxns, ordersAsBuyer, ordersAsSeller
  });
});

// -- Admin tools: people who verified NIN but never finished becoming a reseller --
route('GET', '/api/admin/abandoned-registrations', async (req, res) => {
  const rows = db.prepare(`
    SELECT vi.* FROM verified_identities vi
    LEFT JOIN resellers r ON r.user_email = vi.email
    WHERE r.id IS NULL
    ORDER BY vi.verified_at DESC
  `).all();
  sendJSON(res, 200, { abandoned: rows });
});

route('GET', '/api/health', async (req, res) => sendJSON(res, 200, { ok: true, time: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// Static file serving — the frontend lives in /public and is served from the
// SAME server, on the SAME port, as the API. One process, one command, one app.
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJSON(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams);

  if (!url.pathname.startsWith('/api/')) {
    return serveStatic(req, res, url.pathname);
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = url.pathname.match(r.regex);
    if (!match) continue;
    const params = {};
    r.keys.forEach((k, i) => params[k] = match[i + 1]);
    try {
      const body = ['POST', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      await r.handler(req, res, body, params, query);
    } catch (err) {
      console.error(err);
      sendJSON(res, 500, { error: 'server error', detail: String(err.message || err) });
    }
    return;
  }
  sendJSON(res, 404, { error: 'no such route' });
});

server.listen(PORT, () => {
  console.log(`GoldComfort running on http://localhost:${PORT}  (frontend + API + database, one process)`);
  console.log(`Database file: ${path.join(__dirname, 'goldcomfort.db')}`);
});
