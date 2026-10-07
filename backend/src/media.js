import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { REMOTE_DB, get, run } from './db.js';
import { bad, nowIso, randomToken } from './util.js';

/*
 * Offer images / PDFs and logos; the random file name is the only way to reach one.
 * Stored as files under data/uploads, or in the database (media_files table) when the
 * database is hosted (Vercel has no lasting disk). MEDIA_STORE=disk|db overrides.
 */
export const MEDIA_STORE = process.env.MEDIA_STORE || (REMOTE_DB ? 'db' : 'disk');
export const OFFER_MEDIA_DIR = path.join(CONFIG.dataDir, 'uploads', 'offers');
export const OFFER_MEDIA_URL = '/media/offers';
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DIRS = { offers: OFFER_MEDIA_DIR };

if (MEDIA_STORE === 'disk') fs.mkdirSync(OFFER_MEDIA_DIR, { recursive: true });

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
function store(kind, file, buf) {
  if (MEDIA_STORE === 'db') run('INSERT INTO media_files(kind, file, type, data, created_at) VALUES (?,?,?,?,?)', kind, file, MIME[file.split('.').pop()], buf, nowIso());
  else fs.writeFileSync(path.join(DIRS[kind], file), buf);
}
function unstore(kind, file) {
  if (MEDIA_STORE === 'db') run('DELETE FROM media_files WHERE kind = ? AND file = ?', kind, file);
  else fs.rmSync(path.join(DIRS[kind], file), { force: true });
}
/** For serving from the database: { type, data } or null. */
export function readMedia(kind, file) {
  if (!/^[\w-]+\.(jpg|png|webp|pdf)$/.test(String(file))) return null;
  return get('SELECT type, data FROM media_files WHERE kind = ? AND file = ?', kind, file) || null;
}

// Detect by content, not by the name/extension the browser sends.
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (buf.length > 5 && buf.toString('latin1', 0, 5) === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  return null;
}

/** Save an uploaded offer attachment; returns the columns to store on the offer. */
export function saveOfferAttachment(buf, originalName) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Choose an image or PDF to upload');
  if (buf.length > MAX_ATTACHMENT_BYTES) throw bad('File is too large (max 10 MB)');
  const kind = sniff(buf);
  if (!kind) throw bad('Only JPG, PNG, WebP images or PDF files can be attached');
  const file = `${randomToken(18)}.${kind.ext}`;
  store('offers', file, buf);
  const name = String(originalName || '').replace(/[^\w .()-]/g, '').trim().slice(0, 120) || `offer.${kind.ext}`;
  return { attachment_file: file, attachment_type: kind.type, attachment_name: name };
}

export function removeOfferAttachment(file) {
  if (!file || !/^[\w-]+\.(jpg|png|webp|pdf)$/.test(file)) return;
  unstore('offers', file);
}

/** What clients get: { url, kind: 'image' | 'pdf', name } or null. */
export function attachmentView(o) {
  if (!o?.attachment_file) return null;
  return {
    url: `${OFFER_MEDIA_URL}/${o.attachment_file}`,
    kind: o.attachment_type === 'application/pdf' ? 'pdf' : 'image',
    name: o.attachment_name,
  };
}

/* ---------- business logos (images only) ---------- */
export const LOGO_DIR = path.join(CONFIG.dataDir, 'uploads', 'logos');
export const LOGO_URL = '/media/logos';
DIRS.logos = LOGO_DIR;
if (MEDIA_STORE === 'disk') fs.mkdirSync(LOGO_DIR, { recursive: true });

export function saveLogo(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Choose a logo image to upload');
  if (buf.length > 2 * 1024 * 1024) throw bad('Logo is too large (max 2 MB)');
  const kind = sniff(buf);
  if (!kind || kind.ext === 'pdf') throw bad('Logo must be a JPG, PNG or WebP image');
  const file = `${randomToken(18)}.${kind.ext}`;
  store('logos', file, buf);
  return file;
}
export function removeLogo(file) {
  if (!file || !/^[\w-]+\.(jpg|png|webp)$/.test(file)) return;
  unstore('logos', file);
}
export const logoUrl = (file) => (file ? `${LOGO_URL}/${file}` : null);
