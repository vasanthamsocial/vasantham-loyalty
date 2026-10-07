import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { HttpError, bad, normMobile } from './util.js';

/*
 * Firebase integration, switched on service by service.
 *
 *  - Real project:  backend/firebase.config.json (see firebase.config.example.json)
 *  - Local testing: FIREBASE_EMULATOR=1 uses the Firebase Emulator Suite (`npm run firebase:emulators`)
 *  - Neither:       everything runs as before (own OTP, local files)
 */
const EMULATOR_PROJECT = 'demo-vasantham';
const AUTH_EMULATOR_PORT = Number(process.env.FIREBASE_AUTH_EMULATOR_PORT || 9099);

function load() {
  // VL_FIREBASE_CONFIG (JSON, same shape as the file) is for hosts like Vercel where the file isn't deployed
  const file = process.env.FIREBASE_CONFIG_FILE || path.join(CONFIG.root, 'firebase.config.json');
  const cfg = process.env.VL_FIREBASE_CONFIG ? JSON.parse(process.env.VL_FIREBASE_CONFIG)
    : fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (process.env.FIREBASE_EMULATOR === '1' || process.argv.includes('--firebase-emulator')) {
    return {
      enabled: true,
      emulator: true,
      projectId: EMULATOR_PROJECT,
      web: { apiKey: 'demo-api-key', authDomain: `${EMULATOR_PROJECT}.firebaseapp.com`, projectId: EMULATOR_PROJECT },
      services: { auth: true, ...(cfg.services || {}) },
    };
  }
  return {
    enabled: !!(cfg.enabled && cfg.projectId),
    emulator: false,
    projectId: cfg.projectId,
    web: cfg.web || {},
    serviceAccountFile: cfg.serviceAccountFile ? path.resolve(CONFIG.root, cfg.serviceAccountFile) : null,
    services: cfg.services || {},
  };
}

export const FIREBASE = load();
export const firebaseService = (name) => FIREBASE.enabled && !!FIREBASE.services?.[name];
/** 'firebase' when Firebase Authentication sends and checks OTPs, else the built-in OTP. */
export const otpProvider = () => (firebaseService('auth') ? 'firebase' : 'local');

let adminApp;
async function app() {
  if (adminApp) return adminApp;
  if (FIREBASE.emulator) process.env.FIREBASE_AUTH_EMULATOR_HOST ||= `127.0.0.1:${AUTH_EMULATOR_PORT}`;
  const { initializeApp, getApps, cert } = await import('firebase-admin/app');
  const saJson = process.env.VL_FIREBASE_SERVICE_ACCOUNT
    || (FIREBASE.serviceAccountFile && fs.existsSync(FIREBASE.serviceAccountFile) ? fs.readFileSync(FIREBASE.serviceAccountFile, 'utf8') : null);
  const sa = saJson ? { credential: cert(JSON.parse(saJson)) } : {};
  adminApp = getApps()[0] || initializeApp({ projectId: FIREBASE.projectId, ...sa });
  return adminApp;
}

/**
 * Check a Firebase phone sign-in and return the verified 10-digit mobile.
 * maxAgeSec makes sure the OTP was entered just now (not an old session).
 */
export async function verifyPhoneToken(idToken, { maxAgeSec = 600 } = {}) {
  if (!idToken) throw bad('OTP verification is missing. Please request a new OTP.');
  const { getAuth } = await import('firebase-admin/auth');
  let d;
  try {
    d = await getAuth(await app()).verifyIdToken(String(idToken));
  } catch {
    throw new HttpError(401, 'OTP verification failed or expired. Please request a new OTP.');
  }
  const mobile = normMobile(d.phone_number);
  if (d.firebase?.sign_in_provider !== 'phone' || !mobile) throw new HttpError(401, 'This sign-in is not a phone OTP verification');
  if (Date.now() / 1000 - d.auth_time > maxAgeSec) throw bad('OTP verification expired. Please request a new OTP.');
  return { mobile, uid: d.uid };
}

/** What the browser needs to run Firebase phone OTP (public values only). */
export function clientAuthConfig(req) {
  if (otpProvider() !== 'firebase') return { otpProvider: 'local' };
  return {
    otpProvider: 'firebase',
    firebase: FIREBASE.web,
    // the emulator is reached on the same host the page came from (localhost, 10.0.2.2 in the Android emulator, LAN IP)
    authEmulatorUrl: FIREBASE.emulator ? `http://${req.hostname}:${AUTH_EMULATOR_PORT}` : null,
    devOtp: FIREBASE.emulator && CONFIG.devShowOtp,
  };
}

/** Emulator only: the OTP the emulator "sent", so demo mode can show it like before. */
export async function emulatorOtp(mobile) {
  if (!FIREBASE.emulator || !CONFIG.devShowOtp) return undefined;
  try {
    const r = await fetch(`http://127.0.0.1:${AUTH_EMULATOR_PORT}/emulator/v1/projects/${FIREBASE.projectId}/verificationCodes`);
    const { verificationCodes = [] } = await r.json();
    return verificationCodes.filter((v) => v.phoneNumber === `+91${mobile}`).at(-1)?.code;
  } catch {
    return undefined;
  }
}
