import crypto from 'node:crypto';
import { all, get, run, tx } from './db.js';
import { audit, customerActor } from './audit.js';
import { grantReward, normaliseReward, rewardLabel } from './rewards.js';
import { HttpError, addDays, bad, fmtRupees, isDate, istDate, maskMobile, nowIso, toPaise } from './util.js';

/**
 * Referral programme.
 * An existing customer shares their code (or link). A NEW customer enters it in the app; the
 * referral stays PENDING until the new customer's first qualifying Vasantham bill arrives in
 * the daily upload, then both get their rewards.
 *
 * Fraud controls: the referee must be a genuinely new account (enrolled recently, no purchases
 * ever) and can only ever be referred once; no self-referral or A↔B loops; the referrer must be
 * an active customer who has shopped; per-referrer lifetime and daily caps; a qualification
 * window; mobile OTP on every account (one account per mobile); admins can reject a pending referral.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const currentProgram = (date = istDate()) =>
  get('SELECT * FROM referral_programs WHERE active = 1 AND valid_from <= ? AND valid_to >= ? ORDER BY id DESC LIMIT 1', date, date);

export function referralCode(customer) {
  if (customer.referral_code) return customer.referral_code;
  for (;;) {
    const code = `VR${Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
    if (!get('SELECT 1 FROM customers WHERE referral_code = ?', code)) {
      run('UPDATE customers SET referral_code = ? WHERE id = ? AND referral_code IS NULL', code, customer.id);
      return get('SELECT referral_code FROM customers WHERE id = ?', customer.id).referral_code;
    }
  }
}

const hasPurchased = (customerId) => !!get("SELECT 1 FROM purchases WHERE customer_id = ? AND bill_type = 'SALE' LIMIT 1", customerId);

/** Can this customer still enter someone's code? */
export function refereeEligibility(c, p = currentProgram()) {
  if (!p) return { ok: false, reason: 'No referral programme is running right now' };
  if (get('SELECT 1 FROM referrals WHERE referee_id = ?', c.id)) return { ok: false, reason: 'A referral code has already been used for this account' };
  if (hasPurchased(c.id)) return { ok: false, reason: 'Referral codes are for new customers who have not shopped with us yet' };
  if (c.enrolled_at < addDays(istDate(), -p.new_customer_days)) return { ok: false, reason: `Referral codes must be entered within ${p.new_customer_days} days of joining` };
  return { ok: true };
}

export function applyReferral(referee, rawCode, ip) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) throw bad('Enter a referral code');
  return tx(() => {
    const p = currentProgram();
    const c = get('SELECT * FROM customers WHERE id = ?', referee.id);
    const el = refereeEligibility(c, p);
    if (!el.ok) throw bad(el.reason);
    const referrer = get('SELECT * FROM customers WHERE referral_code = ?', code);
    if (!referrer) throw bad('Referral code not found. Check it with your friend.');
    if (referrer.id === c.id) throw bad('You cannot use your own referral code');
    if (referrer.status !== 'ACTIVE' || !hasPurchased(referrer.id)) throw bad('This referral code is not active');
    if (get('SELECT 1 FROM referrals WHERE referrer_id = ? AND referee_id = ?', c.id, referrer.id)) throw bad('You cannot use the code of someone you referred');
    const used = get("SELECT COUNT(*) n FROM referrals WHERE referrer_id = ? AND program_id = ? AND status IN ('PENDING','REWARDED')", referrer.id, p.id).n;
    if (used >= p.max_referrals) throw bad('This referral code has reached its limit');
    const today = get("SELECT COUNT(*) n FROM referrals WHERE referrer_id = ? AND date(created_at, '+330 minutes') = ?", referrer.id, istDate()).n;
    if (today >= p.max_per_day) throw bad('This referral code has been used too many times today. Please try again tomorrow.');
    const id = Number(run("INSERT INTO referrals(program_id, referrer_id, referee_id, code, status, created_at) VALUES (?,?,?,?,'PENDING',?)",
      p.id, referrer.id, c.id, code, nowIso()).lastInsertRowid);
    audit(customerActor(c), 'REFERRAL_APPLIED', 'referral', id, { referrer_id: referrer.id, code }, ip);
    return get('SELECT * FROM referrals WHERE id = ?', id);
  });
}

const rewardOf = (p, who) => ({ type: p[`${who}_reward_type`], cp: p[`${who}_cp`], offer_id: p[`${who}_offer_id`] });

/** After an upload: reward pending referrals whose referee has made a qualifying Vasantham purchase. */
export function qualifyReferrals(customerIds) {
  let rewarded = 0;
  for (const cid of customerIds) {
    const r = get("SELECT * FROM referrals WHERE referee_id = ? AND status = 'PENDING'", cid);
    if (!r) continue;
    const p = get('SELECT * FROM referral_programs WHERE id = ?', r.program_id);
    const start = istDate(new Date(r.created_at));
    const bill = get(
      `SELECT p.* FROM purchases p JOIN branches b ON b.id = p.branch_id JOIN businesses bz ON bz.id = b.business_id AND bz.can_earn = 1
        WHERE p.customer_id = ? AND p.bill_type = 'SALE' AND p.net_paise >= ? AND p.bill_date BETWEEN ? AND ?
        ORDER BY p.bill_date, p.id LIMIT 1`,
      cid, p.min_purchase_paise, start, addDays(start, p.qualify_days),
    );
    if (!bill) continue;
    tx(() => {
      const upd = run("UPDATE referrals SET status = 'REWARDED', qualified_at = ?, purchase_id = ? WHERE id = ? AND status = 'PENDING'", nowIso(), bill.id, r.id);
      if (!upd.changes) return;
      const referee = get('SELECT * FROM customers WHERE id = ?', cid);
      grantReward(cid, rewardOf(p, 'referee'), { source: 'REFERRAL', title: 'Welcome reward unlocked', note: 'Thanks for joining Vasantham Rewards', validDays: p.reward_valid_days });
      grantReward(r.referrer_id, rewardOf(p, 'referrer'), {
        source: 'REFERRAL', title: 'Referral reward', note: `Your friend ${referee.name || maskMobile(referee.mobile)} made their first purchase`, validDays: p.reward_valid_days,
      });
      audit({ type: 'SYSTEM' }, 'REFERRAL_REWARDED', 'referral', r.id, { purchase_id: bill.id }, null);
      rewarded++;
    });
  }
  return rewarded;
}

/** Pending referrals past their qualification window. */
export function expireReferrals() {
  const today = istDate();
  let n = 0;
  for (const r of all("SELECT r.id, r.created_at, p.qualify_days FROM referrals r JOIN referral_programs p ON p.id = r.program_id WHERE r.status = 'PENDING'")) {
    if (addDays(istDate(new Date(r.created_at)), r.qualify_days) < today) {
      run("UPDATE referrals SET status = 'EXPIRED', reason = 'No qualifying purchase within the time limit' WHERE id = ? AND status = 'PENDING'", r.id);
      n++;
    }
  }
  return n;
}

export function rejectReferral(id, reason, staff, ip) {
  reason = String(reason || '').trim();
  if (!reason) throw bad('A reason is required');
  const r = get('SELECT * FROM referrals WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Referral not found');
  if (r.status !== 'PENDING') throw bad(`Referral is already ${r.status.toLowerCase()}`);
  run("UPDATE referrals SET status = 'REJECTED', reason = ?, resolved_by = ? WHERE id = ?", reason, staff.id, r.id);
  audit({ type: staff.role, id: staff.id, name: staff.name }, 'REFERRAL_REJECTED', 'referral', r.id, { reason }, ip);
}

/* ---------- programme admin ---------- */
export function normaliseProgram(b = {}) {
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) throw bad('Programme name is required');
  if (!isDate(b.valid_from) || !isDate(b.valid_to) || b.valid_to < b.valid_from) throw bad('Valid from / to dates are invalid');
  const int = (v, lo, hi, label, dflt) => {
    const n = v === '' || v == null ? dflt : parseInt(v, 10);
    if (!(n >= lo && n <= hi)) throw bad(`${label} must be between ${lo} and ${hi}`);
    return n;
  };
  const referrer = normaliseReward(b.referrer_reward, 'Referrer reward');
  const referee = normaliseReward(b.referee_reward, 'New customer reward');
  return {
    name,
    active: b.active === false || b.active === 0 ? 0 : 1,
    valid_from: b.valid_from,
    valid_to: b.valid_to,
    min_purchase_paise: toPaise(b.min_purchase) ?? 0,
    qualify_days: int(b.qualify_days, 1, 180, 'Qualification window (days)', 30),
    referrer_reward_type: referrer.type, referrer_cp: referrer.cp, referrer_offer_id: referrer.offer_id,
    referee_reward_type: referee.type, referee_cp: referee.cp, referee_offer_id: referee.offer_id,
    reward_valid_days: int(b.reward_valid_days, 1, 365, 'Reward validity (days)', 30),
    max_referrals: int(b.max_referrals, 1, 1000, 'Maximum referrals per customer', 10),
    max_per_day: int(b.max_per_day, 1, 100, 'Maximum referrals per day', 3),
    new_customer_days: int(b.new_customer_days, 1, 365, 'New customer window (days)', 30),
  };
}
const PCOLS = ['name', 'active', 'valid_from', 'valid_to', 'min_purchase_paise', 'qualify_days', 'referrer_reward_type', 'referrer_cp', 'referrer_offer_id',
  'referee_reward_type', 'referee_cp', 'referee_offer_id', 'reward_valid_days', 'max_referrals', 'max_per_day', 'new_customer_days'];

export function saveProgram(id, body, staff, ip) {
  const p = normaliseProgram(body);
  if (id) {
    if (!get('SELECT 1 FROM referral_programs WHERE id = ?', id)) throw new HttpError(404, 'Programme not found');
    run(`UPDATE referral_programs SET ${PCOLS.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`, ...PCOLS.map((k) => p[k]), staff.id, nowIso(), id);
  } else {
    id = Number(run(`INSERT INTO referral_programs(${PCOLS.join(', ')}, created_by, created_at) VALUES (${PCOLS.map(() => '?').join(',')},?,?)`,
      ...PCOLS.map((k) => p[k]), staff.id, nowIso()).lastInsertRowid);
  }
  audit({ type: staff.role, id: staff.id, name: staff.name }, 'REFERRAL_PROGRAM_SAVED', 'referral_program', id, p, ip);
  return id;
}

export function programSummary(p) {
  if (!p) return null;
  return {
    id: p.id, name: p.name, valid_to: p.valid_to, min_purchase: p.min_purchase_paise ? fmtRupees(p.min_purchase_paise) : null, qualify_days: p.qualify_days,
    referrer_reward: rewardLabel(rewardOf(p, 'referrer')), referee_reward: rewardLabel(rewardOf(p, 'referee')), max_referrals: p.max_referrals,
  };
}

export function referralReport({ status = '' } = {}) {
  const programs = all('SELECT * FROM referral_programs ORDER BY id DESC').map((p) => ({
    ...p, ...programSummary(p),
    stats: get(
      `SELECT COUNT(*) total, SUM(status = 'PENDING') pending, SUM(status = 'REWARDED') rewarded, SUM(status = 'REJECTED') rejected, SUM(status = 'EXPIRED') expired
         FROM referrals WHERE program_id = ?`, p.id,
    ),
  }));
  const rows = all(
    `SELECT r.*, a.mobile referrer_mobile, a.name referrer_name, b.mobile referee_mobile, b.name referee_name, pu.net_paise qualifying_paise, pu.bill_date qualifying_date
       FROM referrals r JOIN customers a ON a.id = r.referrer_id JOIN customers b ON b.id = r.referee_id LEFT JOIN purchases pu ON pu.id = r.purchase_id
      WHERE (? = '' OR r.status = ?) ORDER BY r.id DESC LIMIT 500`,
    status, status,
  );
  const top = all(
    `SELECT a.mobile, a.name, COUNT(*) referrals, SUM(r.status = 'REWARDED') converted FROM referrals r JOIN customers a ON a.id = r.referrer_id
      GROUP BY r.referrer_id ORDER BY converted DESC, referrals DESC LIMIT 10`,
  );
  return { programs, rows, top };
}
