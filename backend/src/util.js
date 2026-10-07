import crypto from 'node:crypto';
import { CONFIG } from './config.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);

/* ---------- Points & money ----------
 * Money is stored as integer paise. Points are stored as integer
 * "centipoints" (1/100 point) — the credited, truncated value. The exact
 * (unrounded) points of each bill are kept separately in purchases.raw_points.
 */

/** Eligible value (paise) -> credited centipoints, truncated (never rounded). */
export function earnCentipoints(netPaise) {
  if (!Number.isFinite(netPaise) || netPaise <= 0) return 0;
  // points = rupees / rupeesPerPoint  =>  centipoints = paise / rupeesPerPoint
  return Math.floor(netPaise / CONFIG.rupeesPerPoint);
}

/** Exact points with full precision (for record keeping). */
export function rawPoints(netPaise) {
  return netPaise / (CONFIG.rupeesPerPoint * 100);
}

/** Centipoints -> reward value in paise. 1 cp = ₹0.02 = 2 paise at ₹2/point. */
export function cpToPaise(cp) {
  return cp * CONFIG.pointValueRupees;
}

export function fmtPoints(cp) {
  const neg = cp < 0;
  const a = Math.abs(cp);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

export function fmtRupees(paise) {
  const neg = paise < 0;
  const a = Math.abs(Math.round(paise));
  const r = Math.floor(a / 100);
  const p = a % 100;
  const s = r.toLocaleString('en-IN');
  return `${neg ? '-' : ''}₹${s}${p ? '.' + String(p).padStart(2, '0') : ''}`;
}

/** Parse a user-entered point amount ("50", "12.5", "12.75") to centipoints. */
export function parsePointsInput(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw bad('Points must be a positive number with at most 2 decimals');
  const [i, f = ''] = s.split('.');
  return Number(i) * 100 + Number(f.padEnd(2, '0'));
}

/** Parse rupee amount (number or string, may contain ₹ and commas) to paise. */
export function toPaise(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  const s = String(v).replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '');
  if (s === '' || !/^-?\d*(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/* ---------- Identity ---------- */

/** Normalise an Indian mobile number to 10 digits, or null if invalid. */
export function normMobile(v) {
  if (v === null || v === undefined) return null;
  let d = String(typeof v === 'number' ? Math.round(v) : v).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export function maskMobile(m) {
  return m ? `${m.slice(0, 4)}XXXXXX` : '';
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10);
  return s;
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/* ---------- Time (IST business dates) ---------- */

export const nowIso = () => new Date().toISOString();

export function istDate(d = new Date()) {
  const t = (d instanceof Date ? d : new Date(d)).getTime() + CONFIG.timezoneOffsetMin * 60000;
  return new Date(t).toISOString().slice(0, 10);
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "23 Sep 2026, 6:42 PM" in IST */
export function istFriendly(d = new Date()) {
  const t = new Date((d instanceof Date ? d : new Date(d)).getTime() + CONFIG.timezoneOffsetMin * 60000);
  const h = t.getUTCHours();
  return `${t.getUTCDate()} ${MON[t.getUTCMonth()]} ${t.getUTCFullYear()}, ${((h + 11) % 12) + 1}:${String(t.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
