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
function flutterwaveTransfer(reseller, amountNaira) {
  console.log(`[stub] Would transfer ₦${amountNaira} to ${reseller.bank_name} •••• ${String(reseller.bank_acct).slice(-4)}`);
  return { success: true, reference: 'STUB-' + crypto.randomUUID() };
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

// -- Auth --
route('POST', '/api/auth/login', async (req, res, body) => {
  let identity;
  try {
    identity = await verifyGoogleToken(body.idToken);
  } catch (err) {
    return sendJSON(res, 401, { error: 'Google sign-in verification failed: ' + err.message });
  }
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(identity.email);
  if (!existing) {
    db.prepare('INSERT INTO users (email, name, is_admin) VALUES (?, ?, ?)')
      .run(identity.email, identity.name, identity.email === ADMIN_EMAIL ? 1 : 0);
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(identity.email);
  sendJSON(res, 200, { user });
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
  db.prepare('DELETE FROM verified_identities WHERE email = ?').run(decodeURIComponent(params.email));
  sendJSON(res, 200, { reset: true });
});

// -- Resellers --
route('POST', '/api/resellers', async (req, res, body) => {
  const verified = db.prepare('SELECT * FROM verified_identities WHERE email = ?').get(body.email);
  if (!verified) return sendJSON(res, 400, { error: 'Identity must be verified before becoming a reseller' });

  const info = db.prepare(`
    INSERT INTO resellers (user_email, biz_name, biz_state, address, location_pinned, bank_name, bank_acct, bank_acct_name, plan, plan_expires_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(body.email, body.bizName, body.bizState || '', body.address || '', body.locationPinned ? 1 : 0,
         body.bankName || '', body.bankAcct || '', body.bankAcctName || '',
         body.plan || 'Pro (₦6,000/mo)', planExpiryDate(), body.source || 'self');

  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(info.lastInsertRowid);
  sendJSON(res, 201, { reseller });
});

route('GET', '/api/resellers', async (req, res, body, params, query) => {
  let list = db.prepare('SELECT * FROM resellers ORDER BY created_at DESC').all();
  if (query.email) list = list.filter(r => r.user_email === query.email);
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

route('POST', '/api/resellers/:id/extend', async (req, res, body, params) => {
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(params.id);
  if (!r) return sendJSON(res, 404, { error: 'not found' });
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
      resellerId: l.reseller_id,
      seller_banned: reseller ? !!reseller.banned : false,
      unavailable: reseller ? isPlanExpired(reseller) : true
    };
  }).filter(l => !l.seller_banned);
  sendJSON(res, 200, { listings: enriched });
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

  const info = db.prepare(`
    INSERT INTO orders (listing_id, reseller_id, buyer_email, qty, subtotal, fee, discount_applied, credit_used, total, commission, reseller_payout,
      cust_state, address, cust_phone, cust_whatsapp, cust_email, status)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(listing.id, reseller.id, body.buyerEmail, qty, originalSubtotal, discountApplied, creditUsed, total, commission, resellerPayout,
         body.custState || null, body.address, body.custPhone || null, body.custWhatsapp || null, body.custEmail || null);

  for (const cid of appliedCredits) {
    db.prepare('UPDATE customer_credits SET used = 1, used_order_id = ? WHERE id = ?').run(info.lastInsertRowid, cid);
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
    const reseller = db.prepare('SELECT biz_name FROM resellers WHERE id = ?').get(o.reseller_id);
    return { ...o, listing_name: listing?.name || 'Item', listing_type: listing?.type || 'product', seller_name: reseller?.biz_name || 'Seller' };
  });
  sendJSON(res, 200, { orders: enriched });
});

route('POST', '/api/orders/:id/accept', async (req, res, body, params) => {
  db.prepare("UPDATE orders SET status = 'preparing' WHERE id = ? AND status = 'pending'").run(params.id);
  sendJSON(res, 200, { status: 'preparing' });
});
route('POST', '/api/orders/:id/reject', async (req, res, body, params) => {
  db.prepare("UPDATE orders SET status = 'seller-declined' WHERE id = ?").run(params.id);
  // TODO: trigger a real Flutterwave refund to the buyer's original payment method here.
  sendJSON(res, 200, { status: 'seller-declined' });
});
route('POST', '/api/orders/:id/advance', async (req, res, body, params) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(params.id);
  if (!order) return sendJSON(res, 404, { error: 'not found' });
  const next = order.status === 'preparing' ? 'on-way' : order.status === 'on-way' ? 'arrived' : order.status;
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(next, params.id);
  sendJSON(res, 200, { status: next });
});
route('POST', '/api/orders/:id/confirm', async (req, res, body, params) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(params.id);
  if (!order) return sendJSON(res, 404, { error: 'not found' });
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(order.reseller_id);
  db.prepare("UPDATE orders SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?").run(params.id);
  const transfer = flutterwaveTransfer(reseller, order.reseller_payout);
  sendJSON(res, 200, { status: 'delivered', payout: order.reseller_payout, transfer });
});

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
    const reseller = db.prepare('SELECT biz_name, banned FROM resellers WHERE id = ?').get(br.reseller_id);
    return { ...br, seller: reseller?.biz_name || 'Unknown', seller_banned: !!reseller?.banned };
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
// type 'signup': admin-issued, percent off a reseller plan payment, to attract new sellers.
// type 'product': a reseller's own code, stored directly on their listing (see /api/listings).
route('POST', '/api/coupons', async (req, res, body) => {
  try {
    const info = db.prepare('INSERT INTO coupons (code, type, reseller_id, discount_percent) VALUES (?, ?, ?, ?)')
      .run(body.code.trim().toUpperCase(), body.type, body.resellerId || null, body.discountPercent);
    sendJSON(res, 201, { id: info.lastInsertRowid });
  } catch (e) {
    sendJSON(res, 409, { error: 'That coupon code already exists' });
  }
});
route('GET', '/api/coupons', async (req, res, body, params, query) => {
  let list = db.prepare('SELECT * FROM coupons WHERE active = 1 ORDER BY created_at DESC').all();
  if (query.type) list = list.filter(c => c.type === query.type);
  sendJSON(res, 200, { coupons: list });
});
route('GET', '/api/coupons/:code/check', async (req, res, body, params) => {
  const c = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(decodeURIComponent(params.code).trim().toUpperCase());
  if (!c) return sendJSON(res, 404, { error: 'Invalid or expired coupon' });
  sendJSON(res, 200, { coupon: c });
});
route('POST', '/api/coupons/:id/deactivate', async (req, res, body, params) => {
  db.prepare('UPDATE coupons SET active = 0 WHERE id = ?').run(params.id);
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

// -- Phone OTP verification (Termii) for reseller sign-up --
// TODO: replace with a real Termii send-OTP call using TERMII_API_KEY + TERMII_SENDER_ID:
//   POST https://api.ng.termii.com/api/sms/otp/send
//   body: { api_key, message_type: 'NUMERIC', to: phone, from: TERMII_SENDER_ID, channel: 'generic', pin_attempts: 3, pin_time_to_live: 5, pin_length: 4, pin_placeholder: '< 1234 >', message_text: 'Your GoldComfort code is < 1234 >', pin_type: 'NUMERIC' }
// and verify via POST https://api.ng.termii.com/api/sms/otp/verify with { api_key, pin_id, pin }
function generateOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
route('POST', '/api/otp/send', async (req, res, body) => {
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
  db.prepare(`
    INSERT INTO otp_codes (phone, code, expires_at, verified) VALUES (?, ?, ?, 0)
    ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, verified = 0
  `).run(body.phone, code, expiresAt);
  console.log(`[stub] Termii SMS to ${body.phone}: Your GoldComfort code is ${code}`);
  // In dev/stub mode we return the code so you can test without a real Termii key.
  // Once TERMII_API_KEY is set, stop returning `code` in the response.
  sendJSON(res, 200, { sent: true, devCode: process.env.TERMII_API_KEY ? undefined : code });
});
route('POST', '/api/otp/verify', async (req, res, body) => {
  const row = db.prepare('SELECT * FROM otp_codes WHERE phone = ?').get(body.phone);
  if (!row || row.code !== body.code || new Date() > new Date(row.expires_at)) {
    return sendJSON(res, 400, { verified: false, error: 'Incorrect or expired code' });
  }
  db.prepare('UPDATE otp_codes SET verified = 1 WHERE phone = ?').run(body.phone);
  sendJSON(res, 200, { verified: true });
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
