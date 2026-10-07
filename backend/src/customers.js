import { all, get, run } from './db.js';
import { pointsSummary } from './points.js';
import { cpToPaise, fmtPoints, nowIso, randomDigits } from './util.js';

export function newCustomerCode() {
  for (;;) {
    const code = `VC${randomDigits(7)}`;
    if (!get('SELECT 1 FROM customers WHERE code = ?', code)) return code;
  }
}

/** Find by mobile, or create a basic loyalty account (enrolment without the app). */
export function findOrCreateByMobile(mobile, { name = null, via = 'POS', branchId = null, posCode = null } = {}) {
  let c = get('SELECT * FROM customers WHERE mobile = ?', mobile);
  if (c) return { customer: c, created: false };
  const code = newCustomerCode();
  run(
    'INSERT INTO customers(code, mobile, name, pos_customer_code, home_branch_id, enrolled_via, enrolled_at) VALUES (?,?,?,?,?,?,?)',
    code, mobile, name, posCode, branchId, via, nowIso(),
  );
  c = get('SELECT * FROM customers WHERE mobile = ?', mobile);
  return { customer: c, created: true };
}

/** Savings = points redeemed (₹) + offer savings + coupons, from completed redemptions. */
export function savings(customerId) {
  const r = get(
    `SELECT
       COALESCE(SUM(CASE WHEN r.kind = 'POINTS' THEN r.value_paise END),0) points_paise,
       COALESCE(SUM(CASE WHEN r.kind = 'OFFER' AND o.coupon_code IS NULL THEN r.value_paise END),0) offers_paise,
       COALESCE(SUM(CASE WHEN r.kind = 'OFFER' AND o.coupon_code IS NOT NULL THEN r.value_paise END),0) coupons_paise
     FROM redemptions r LEFT JOIN offers o ON o.id = r.offer_id
     WHERE r.customer_id = ? AND r.status IN ('APPROVED','SUBMITTED','BILLED','RECONCILED')`,
    customerId,
  );
  return { ...r, total_paise: r.points_paise + r.offers_paise + r.coupons_paise };
}

export function customerCard(c) {
  const s = pointsSummary(c.id);
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    mobile: c.mobile,
    dob: c.dob,
    anniversary: c.anniversary,
    // the app asks for at least one special date (birthday or anniversary)
    profile_complete: !!(c.name && (c.dob || c.anniversary)),
    status: c.status,
    app_registered: !!c.app_registered_at,
    balance_cp: c.balance_cp,
    balance: fmtPoints(c.balance_cp),
    reward_value_paise: Math.max(0, cpToPaise(c.balance_cp)),
    earned: fmtPoints(s.earned_cp),
    redeemed: fmtPoints(s.redeemed_cp),
    reversed: fmtPoints(s.reversed_cp),
    first_purchase_date: c.first_purchase_date,
    last_purchase_date: c.last_purchase_date,
    segments: all('SELECT segment FROM customer_segments WHERE customer_id = ?', c.id).map((r) => r.segment),
  };
}
