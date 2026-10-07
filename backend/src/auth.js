import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { get, run } from './db.js';
import { HttpError, bad, nowIso, randomDigits, sha256 } from './util.js';
import { accessRoleOf, permissionsOf } from './rbac.js';

/* ---------- server secret ---------- */
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  if (process.env.VERCEL) throw new Error('APP_SECRET must be set in the Vercel project settings');
  const f = path.join(CONFIG.dataDir, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}
const SECRET = loadSecret();

const hmac = (s, n = 43) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, n);
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* ---------- passwords ---------- */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, h] = String(stored).split('$');
  if (!salt || !h) return false;
  return safeEq(crypto.scryptSync(pw, salt, 64).toString('hex'), h);
}

/* ---------- signed tokens (sessions, tickets) ---------- */
export function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body)}`;
}
export function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEq(hmac(body), sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch {
    return null;
  }
}

export const staffSession = (s) =>
  sign({ t: 'staff', id: s.id, exp: Date.now() + CONFIG.staffSessionHours * 3600e3 });
export const customerSession = (c) =>
  sign({ t: 'cust', id: c.id, exp: Date.now() + CONFIG.customerSessionDays * 86400e3 });

/** Proof (held by the manager panel) that a customer was identified in person. */
export const verificationTicket = (customerId, staffId, method) =>
  sign({ t: 'ticket', cid: customerId, sid: staffId, m: method, exp: Date.now() + CONFIG.verificationTicketSec * 1000 });

export function checkTicket(ticket, staffId) {
  const p = verify(ticket);
  if (!p || p.t !== 'ticket' || p.sid !== staffId) throw bad('Customer verification expired. Please scan the QR or verify OTP again.');
  return p;
}

/* ---------- rotating customer QR ----------
 * Format: VC1.<customerCode>.<unixSeconds base36>.<sig>
 * The app refreshes it every minute; the server accepts it for a short window,
 * so a screenshot shared with someone else stops working quickly.
 */
export function customerQrPayload(code) {
  const ts = Math.floor(Date.now() / 1000).toString(36);
  const base = `VC1.${code}.${ts}`;
  return { payload: `${base}.${hmac(base, 16)}`, expiresAt: new Date(Date.now() + CONFIG.customerQrValiditySec * 1000).toISOString() };
}
export function parseCustomerQr(s) {
  const m = /^VC1\.([A-Z0-9]+)\.([0-9a-z]+)\.([A-Za-z0-9_-]{16})$/.exec(String(s).trim());
  if (!m) return null;
  const [, code, ts, sig] = m;
  if (!safeEq(hmac(`VC1.${code}.${ts}`, 16), sig)) return { error: 'Invalid customer QR' };
  const age = Date.now() / 1000 - parseInt(ts, 36);
  if (age > CONFIG.customerQrValiditySec || age < -120) return { error: 'Customer QR has expired. Ask the customer to refresh the app.' };
  return { code };
}

/* ---------- OTP ---------- */
export function sendSms(mobile, text) {
  // Integration point for an SMS gateway (MSG91, Gupshup, etc.).
  console.log(`[SMS -> ${mobile}] ${text}`);
}

export function issueOtp(mobile, purpose, ref = null) {
  const recent = get(
    "SELECT COUNT(*) n FROM otps WHERE mobile = ? AND created_at > datetime('now','-1 hour')",
    mobile,
  ).n;
  if (recent >= CONFIG.otpMaxPerHour) throw new HttpError(429, 'Too many OTP requests. Try again later.');
  const code = randomDigits(6);
  run(
    'INSERT INTO otps(mobile, purpose, code_hash, ref, expires_at, created_at) VALUES (?,?,?,?,?,?)',
    mobile, purpose, sha256(`${mobile}:${code}`), ref,
    new Date(Date.now() + CONFIG.otpValiditySec * 1000).toISOString(), nowIso(),
  );
  const msg = purpose === 'LOGIN'
    ? `${code} is your Vasantham Rewards login OTP.`
    : `${code} is the OTP to approve a Vasantham Rewards redemption at the store. Share it only with the store manager in person.`;
  sendSms(mobile, msg);
  return CONFIG.devShowOtp ? code : undefined;
}

export function checkOtp(mobile, purpose, code, ref = null) {
  const o = get(
    `SELECT * FROM otps WHERE mobile = ? AND purpose = ? AND used_at IS NULL AND (ref IS ? OR ref = ?)
     ORDER BY id DESC LIMIT 1`,
    mobile, purpose, ref, ref,
  );
  if (!o || o.expires_at < nowIso()) throw bad('OTP expired or not requested');
  if (o.attempts >= CONFIG.otpMaxAttempts) throw bad('Too many wrong attempts. Request a new OTP.');
  if (!safeEq(sha256(`${mobile}:${String(code).trim()}`), o.code_hash)) {
    run('UPDATE otps SET attempts = attempts + 1 WHERE id = ?', o.id);
    throw bad('Incorrect OTP');
  }
  run('UPDATE otps SET used_at = ? WHERE id = ?', nowIso(), o.id);
}

/* ---------- middleware ---------- */
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

export function requireStaff(...roles) {
  return (req, _res, next) => {
    const p = verify(bearer(req));
    if (!p || p.t !== 'staff') throw new HttpError(401, 'Please log in');
    const s = get(
      `SELECT s.id, s.username, s.name, s.role, s.access_role, s.business_id, s.branch_id, s.active, b.name branch_name, b.code branch_code
         FROM staff s LEFT JOIN branches b ON b.id = s.branch_id WHERE s.id = ?`,
      p.id,
    );
    if (!s || !s.active) throw new HttpError(401, 'Account disabled');
    if (roles.length && !roles.includes(s.role)) throw new HttpError(403, 'Not permitted');
    if (s.role === 'MANAGER' && !s.branch_id) throw new HttpError(403, 'Manager has no branch assigned');
    s.access_role = accessRoleOf(s);
    s.permissions = permissionsOf(s);
    req.staff = s;
    next();
  };
}

export function requireCustomer(req, _res, next) {
  const p = verify(bearer(req));
  if (!p || p.t !== 'cust') throw new HttpError(401, 'Please log in');
  const c = get('SELECT * FROM customers WHERE id = ?', p.id);
  if (!c) throw new HttpError(401, 'Account not found');
  if (c.status === 'BLOCKED') throw new HttpError(403, 'Account is blocked. Please contact the store.');
  req.customer = c;
  next();
}
