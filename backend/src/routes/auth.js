import { Router } from 'express';
import { get, run, tx } from '../db.js';
import { checkOtp, customerSession, issueOtp, staffSession, verifyPassword } from '../auth.js';
import { accessRoleOf } from '../rbac.js';
import { findOrCreateByMobile, customerCard } from '../customers.js';
import { audit, customerActor } from '../audit.js';
import { HttpError, bad, normMobile, nowIso } from '../util.js';
import { clientAuthConfig, emulatorOtp, otpProvider, verifyPhoneToken } from '../firebase.js';

const r = Router();

/** Which OTP system the apps should use (built-in or Firebase). Public values only. */
r.get('/config', (req, res) => res.json(clientAuthConfig(req)));

// With Firebase switched on, OTPs must go through Firebase, so the built-in ones are closed.
const localOtpOnly = () => {
  if (otpProvider() !== 'local') throw bad('Please update the app: OTP is now sent by Firebase.');
};

// Customer login: mobile + OTP. Logging in with the same mobile used at the
// billing counter links the app to the existing account and points.
r.post('/customer/otp', (req, res) => {
  localOtpOnly();
  const mobile = normMobile(req.body?.mobile);
  if (!mobile) throw bad('Enter a valid 10-digit mobile number');
  const devOtp = issueOtp(mobile, 'LOGIN');
  res.json({ sent: true, devOtp });
});

r.post('/customer/verify', (req, res) => {
  localOtpOnly();
  const mobile = normMobile(req.body?.mobile);
  if (!mobile) throw bad('Enter a valid 10-digit mobile number');
  checkOtp(mobile, 'LOGIN', req.body?.otp);
  customerLogin(mobile, req, res);
});

// Firebase phone OTP: the app signs in with Firebase, the server checks it and logs in as above.
r.post('/customer/firebase', async (req, res) => {
  if (otpProvider() !== 'firebase') throw bad('Firebase OTP is not enabled');
  const { mobile } = await verifyPhoneToken(req.body?.idToken);
  customerLogin(mobile, req, res);
});

// Firebase emulator only: show the OTP on screen in demo mode, as the built-in OTP does.
r.get('/dev-otp', async (req, res) => {
  const mobile = normMobile(req.query.mobile);
  res.json({ devOtp: mobile ? await emulatorOtp(mobile) : undefined });
});

function customerLogin(mobile, req, res) {
  const out = tx(() => {
    const { customer, created } = findOrCreateByMobile(mobile, { via: 'APP' });
    const firstLogin = !customer.app_registered_at;
    if (firstLogin) run('UPDATE customers SET app_registered_at = ? WHERE id = ?', nowIso(), customer.id);
    audit(customerActor(customer), firstLogin ? 'APP_REGISTERED' : 'APP_LOGIN', 'customer', customer.id, { newAccount: created }, req.ip);
    return { customer: get('SELECT * FROM customers WHERE id = ?', customer.id), created, firstLogin };
  });
  if (out.customer.status === 'BLOCKED') throw new HttpError(403, 'Account is blocked. Please contact the store.');
  res.json({ token: customerSession(out.customer), customer: customerCard(out.customer), newAccount: out.created, firstLogin: out.firstLogin });
}

r.post('/staff/login', (req, res) => {
  const { username, password } = req.body || {};
  const s = get('SELECT * FROM staff WHERE username = ?', String(username || '').trim());
  if (!s || !s.active || !verifyPassword(String(password || ''), s.password_hash)) {
    audit({ type: 'SYSTEM', name: String(username || '') }, 'STAFF_LOGIN_FAILED', 'staff', s?.id, null, req.ip);
    throw new HttpError(401, 'Invalid username or password');
  }
  run('UPDATE staff SET last_login_at = ? WHERE id = ?', nowIso(), s.id);
  audit({ type: s.role, id: s.id, name: s.name, branch_id: s.branch_id }, 'STAFF_LOGIN', 'staff', s.id, null, req.ip);
  const b = s.branch_id ? get('SELECT name, code FROM branches WHERE id = ?', s.branch_id) : null;
  res.json({ token: staffSession(s), staff: { id: s.id, name: s.name, username: s.username, role: s.role, access_role: accessRoleOf(s), branch_id: s.branch_id, branch_name: b?.name } });
});

export default r;
