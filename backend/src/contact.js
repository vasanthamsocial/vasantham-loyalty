import { all, run } from './db.js';
import { bad } from './util.js';

/** Customer care details shown in the Customer App (stored in store_info). */
export const CARE_KEYS = ['care_phone', 'care_whatsapp', 'care_email', 'care_hours'];

/** Phone as typed (spaces, dashes, +91 allowed); must contain 6–15 digits. Empty -> null. */
export function cleanPhone(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\+?[\d\s()-]+$/.test(s)) throw bad(`${label}: use digits only (spaces, - and a leading + are fine)`);
  const n = s.replace(/\D/g, '').length;
  if (n < 6 || n > 15) throw bad(`${label}: enter a valid phone number`);
  return s.slice(0, 30);
}

/** WhatsApp number as international digits (wa.me format). A 10-digit Indian mobile gets 91 prefixed. */
export function cleanWhatsapp(v, label = 'WhatsApp number') {
  const s = cleanPhone(v, label);
  if (!s) return null;
  let d = s.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  if (d.length < 11) throw bad(`${label}: enter a mobile number, with country code if outside India`);
  return d;
}

export function cleanUrl(v, label = 'Map link') {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { throw bad(`${label}: enter a full link starting with https://`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad(`${label}: enter a full link starting with https://`);
  return s.slice(0, 500);
}

export const cleanText = (v, max) => String(v ?? '').trim().slice(0, max) || null;

export function careInfo() {
  const rows = Object.fromEntries(all('SELECT key, value FROM store_info').map((r) => [r.key, r.value]));
  return Object.fromEntries(CARE_KEYS.map((k) => [k, rows[k] || null]));
}

export function saveCareInfo(body = {}) {
  const email = cleanText(body.care_email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Customer care email is not valid');
  const v = {
    care_phone: cleanPhone(body.care_phone, 'Customer care number'),
    care_whatsapp: cleanWhatsapp(body.care_whatsapp, 'Customer care WhatsApp'),
    care_email: email,
    care_hours: cleanText(body.care_hours, 120),
  };
  for (const [k, val] of Object.entries(v)) {
    run('INSERT INTO store_info(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, val);
  }
  return v;
}

/** Branch contact fields from a request body; only keys present in the body are returned. */
export function branchContactFields(body = {}) {
  const out = {};
  if (body.address !== undefined) out.address = cleanText(body.address, 300);
  if (body.phone !== undefined) out.phone = cleanPhone(body.phone, 'Branch phone');
  if (body.whatsapp !== undefined) out.whatsapp = cleanWhatsapp(body.whatsapp, 'Branch WhatsApp');
  if (body.map_url !== undefined) out.map_url = cleanUrl(body.map_url, 'Google Maps link');
  return out;
}

/** What the Customer App shows under "Stores & contact". */
export function storeDirectory() {
  return {
    branches: all(
      `SELECT b.id, b.name, b.city, b.address, b.phone, b.whatsapp, b.map_url, bz.name business, bz.is_program_owner owner
         FROM branches b JOIN businesses bz ON bz.id = b.business_id AND bz.active = 1
        WHERE b.active = 1 ORDER BY bz.is_program_owner DESC, bz.sort_order, bz.name, b.name`,
    ),
    care: careInfo(),
  };
}
