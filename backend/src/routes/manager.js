import { Router } from 'express';
import { all, get, setting, tx } from '../db.js';
import { checkOtp, checkTicket, issueOtp, parseCustomerQr, requireStaff, verificationTicket } from '../auth.js';
import { ACCESS_ROLES, requirePerm } from '../rbac.js';
import { customerCard, findOrCreateByMobile } from '../customers.js';
import { offersForCustomer } from '../offers.js';
import { CANCEL_REASONS, approve, billAmount, cancelOrReverse, confirmPartnerBill, createRequest, findByToken, markSubmitted, receipt } from '../redemptions.js';
import { branchEligible, businessOfBranch, businessView, getBusiness, pointsCap, ruleOf } from '../businesses.js';
import { managerDaily } from '../analytics.js';
import { audit, staffActor } from '../audit.js';
import { HttpError, bad, istDate, isDate, normMobile, parsePointsInput } from '../util.js';
import { otpProvider, verifyPhoneToken } from '../firebase.js';
import { qrSvg } from './customer.js';

const r = Router();
r.use(requireStaff('MANAGER'), requirePerm('counter.redeem'));

/** What this outlet may do for this customer: the business's rules applied to the customer's balance. */
function eligibility(c, staff) {
  const business = businessOfBranch(staff.branch_id);
  const rule = ruleOf(business.id);
  const cap = pointsCap({ rule, balanceCp: c.balance_cp });
  const reasons = [];
  if (!business.can_redeem) reasons.push(`${business.name} does not accept loyalty redemptions`);
  if (!branchEligible(rule, staff.branch_id)) reasons.push('This outlet is not eligible for redemptions');
  if (rule.min_points_cp && c.balance_cp < rule.min_points_cp) reasons.push('Balance is below the minimum points for redemption');
  return {
    business: businessView(business),
    can_redeem_points: !reasons.length && cap.maxCp > 0,
    reasons,
    max_cp_now: cap.maxCp, // before the % of bill limit, which needs the bill amount
    max_paise_now: cap.maxPaise,
  };
}

function customerInfo(c, staff) {
  const branchId = staff.branch_id;
  const offers = offersForCustomer(c, { branchId, businessId: businessOfBranch(branchId).id });
  return {
    ...customerCard(c),
    eligibility: eligibility(c, staff),
    offers,
    recent: all(
      `SELECT r.id, r.kind, r.cp, r.value_paise, r.status, r.approved_at, r.created_at, b.name branch, o.title offer_title
         FROM redemptions r LEFT JOIN branches b ON b.id = r.branch_id LEFT JOIN offers o ON o.id = r.offer_id
        WHERE r.customer_id = ? AND r.status NOT IN ('CREATED','EXPIRED') ORDER BY r.created_at DESC LIMIT 8`,
      c.id,
    ),
  };
}

r.get('/meta', (req, res) => {
  const business = businessView(businessOfBranch(req.staff.branch_id));
  res.json({ staff: { ...req.staff, business_name: business.name, access_label: ACCESS_ROLES[req.staff.access_role]?.label }, business, cancelReasons: CANCEL_REASONS, otpRequired: !!setting('require_otp_for_mobile_redemption'), today: istDate() });
});

/**
 * Accepts whatever the scanner / camera read:
 *  - rotating customer QR (VC1...) → customer verified in person
 *  - redemption QR from the app (VR1...) → the pending request + customer
 */
r.post('/scan', (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code) throw bad('Nothing scanned');
  const staff = req.staff;
  const redemption = findByToken(code);
  if (redemption) {
    if (redemption.status !== 'CREATED') throw bad(`This redemption is already ${redemption.status.toLowerCase()}`);
    const here = businessOfBranch(staff.branch_id);
    if (redemption.business_id && redemption.business_id !== here.id) {
      throw bad(`This redemption is for ${getBusiness(redemption.business_id)?.name}. Ask the customer to create a new one for ${here.name}.`);
    }
    const c = get('SELECT * FROM customers WHERE id = ?', redemption.customer_id);
    const offer = redemption.offer_id ? get('SELECT id, title, type, value_paise, min_spend_paise, points_cost_cp, coupon_code FROM offers WHERE id = ?', redemption.offer_id) : null;
    audit(staffActor(staff), 'SCAN_REDEMPTION', 'redemption', redemption.id, null, req.ip);
    return res.json({
      type: 'REDEMPTION',
      redemption: { id: redemption.id, kind: redemption.kind, cp: redemption.cp, value_paise: redemption.value_paise, expires_at: redemption.expires_at, offer },
      customer: customerInfo(c, staff),
      ticket: verificationTicket(c.id, staff.id, 'REDEMPTION_QR'),
    });
  }
  const q = parseCustomerQr(code);
  if (q?.error) throw bad(q.error);
  if (q) {
    const c = get('SELECT * FROM customers WHERE code = ?', q.code);
    if (!c) throw bad('Customer not found');
    if (c.status !== 'ACTIVE') throw bad('Customer account is blocked');
    audit(staffActor(staff), 'SCAN_CUSTOMER', 'customer', c.id, null, req.ip);
    return res.json({ type: 'CUSTOMER', customer: customerInfo(c, staff), ticket: verificationTicket(c.id, staff.id, 'CUSTOMER_QR') });
  }
  throw bad('Not a Vasantham Rewards QR code');
});

r.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const mobile = normMobile(q);
  const c = mobile ? get('SELECT * FROM customers WHERE mobile = ?', mobile) : get('SELECT * FROM customers WHERE code = ?', q.toUpperCase());
  if (!c) return res.json({ found: false, mobile });
  audit(staffActor(req.staff), 'SEARCH_CUSTOMER', 'customer', c.id, { q }, req.ip);
  const otpRequired = !!setting('require_otp_for_mobile_redemption');
  res.json({
    found: true,
    customer: customerInfo(c, req.staff),
    otpRequired,
    ticket: otpRequired ? null : verificationTicket(c.id, req.staff.id, 'MOBILE_SEARCH'),
  });
});

r.post('/customers/:id/otp', (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found');
  if (otpProvider() !== 'local') throw bad('OTP is now sent by Firebase. Please reload the Manager Panel.');
  const devOtp = issueOtp(c.mobile, 'REDEEM', String(req.staff.id));
  audit(staffActor(req.staff), 'REDEMPTION_OTP_SENT', 'customer', c.id, null, req.ip);
  res.json({ sent: true, devOtp });
});

r.post('/customers/:id/verify', (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found');
  if (otpProvider() !== 'local') throw bad('OTP is now sent by Firebase. Please reload the Manager Panel.');
  checkOtp(c.mobile, 'REDEEM', req.body?.otp, String(req.staff.id));
  audit(staffActor(req.staff), 'CUSTOMER_OTP_VERIFIED', 'customer', c.id, null, req.ip);
  res.json({ ticket: verificationTicket(c.id, req.staff.id, 'OTP') });
});

// Firebase OTP: the code goes to the customer's phone, the manager enters it here and the
// server checks that the verified number is this customer's (and verified within 5 minutes).
r.post('/customers/:id/verify-firebase', async (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found');
  if (otpProvider() !== 'firebase') throw bad('Firebase OTP is not enabled');
  const { mobile } = await verifyPhoneToken(req.body?.idToken, { maxAgeSec: 300 });
  if (mobile !== c.mobile) throw bad("The OTP was verified for a different mobile number than this customer's");
  audit(staffActor(req.staff), 'CUSTOMER_OTP_VERIFIED', 'customer', c.id, { provider: 'firebase' }, req.ip);
  res.json({ ticket: verificationTicket(c.id, req.staff.id, 'OTP') });
});

/** Walk-in enrolment at the store (no app needed). */
r.post('/enrol', requirePerm('counter.enrol'), (req, res) => {
  const mobile = normMobile(req.body?.mobile);
  if (!mobile) throw bad('Enter a valid 10-digit mobile number');
  const name = String(req.body?.name || '').trim() || null;
  const { customer, created } = findOrCreateByMobile(mobile, { name, via: 'STORE', branchId: req.staff.branch_id });
  if (created) audit(staffActor(req.staff), 'CUSTOMER_ENROLLED', 'customer', customer.id, { mobile }, req.ip);
  res.json({ created, customer: customerInfo(customer, req.staff) });
});

const approveOpts = (b = {}) => ({
  billPaise: billAmount(b.bill_amount),
  cp: b.points === undefined || b.points === null || b.points === '' ? null : parsePointsInput(b.points),
});

/** Approve a request the customer created in the app (after scanning its QR). */
r.post('/redemptions/:id/approve', (req, res) => {
  const t = checkTicket(req.body?.ticket, req.staff.id);
  const red = get('SELECT customer_id FROM redemptions WHERE id = ?', req.params.id);
  if (!red || red.customer_id !== t.cid) throw bad('Scan the redemption QR again');
  const out = approve(req.params.id, req.staff, req.ip, approveOpts(req.body));
  res.json(receipt(out.id));
});

/** Outlets without a daily Excel upload confirm the final bill here. */
r.post('/redemptions/:id/bill', (req, res) => {
  confirmPartnerBill(req.params.id, req.staff, { billNo: req.body?.bill_no, billPaise: billAmount(req.body?.bill_amount) }, req.ip);
  res.json(receipt(req.params.id));
});

/** Manager enters the redemption for a verified customer (QR scan or OTP). */
r.post('/redemptions/direct', (req, res) => {
  const t = checkTicket(req.body?.ticket, req.staff.id);
  const { kind, points, offerId } = req.body || {};
  const opts = approveOpts({ bill_amount: req.body?.bill_amount }); // validate before creating anything
  // one transaction: if approval fails (e.g. over the business's limit) no request is left behind
  const out = tx(() => {
    const red = createRequest({
      customerId: t.cid,
      kind,
      cp: kind === 'POINTS' ? parsePointsInput(points) : 0,
      offerId,
      via: 'MANAGER',
      verifiedBy: t.m,
      branchId: req.staff.branch_id,
    });
    return approve(red.id, req.staff, req.ip, opts);
  });
  res.json(receipt(out.id));
});

function ownBranch(req) {
  const red = get('SELECT branch_id, status FROM redemptions WHERE id = ?', req.params.id);
  if (!red) throw new HttpError(404, 'Redemption not found');
  if (red.branch_id !== req.staff.branch_id) throw new HttpError(403, 'Redemption belongs to another branch');
}

r.get('/redemptions/:id', async (req, res) => {
  ownBranch(req);
  const rc = receipt(req.params.id);
  res.json({ ...rc, qr: await qrSvg(rc.id) });
});

r.post('/redemptions/:id/submit', (req, res) => {
  markSubmitted(req.params.id, req.staff);
  res.json(receipt(req.params.id));
});

r.post('/redemptions/:id/cancel', (req, res) => {
  cancelOrReverse(req.params.id, staffActor(req.staff), req.body?.reason, req.body?.note, req.ip);
  res.json(receipt(req.params.id));
});

r.get('/redemptions', (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : istDate();
  res.json(all(
    `SELECT r.id, r.kind, r.cp, r.value_paise, r.status, r.approved_at, r.cancel_reason, r.recon_status, c.mobile, c.name customer_name, s.name approved_by_name, o.title offer_title
       FROM redemptions r JOIN customers c ON c.id = r.customer_id LEFT JOIN staff s ON s.id = r.approved_by LEFT JOIN offers o ON o.id = r.offer_id
      WHERE r.branch_id = ? AND date(r.approved_at,'+330 minutes') = ? ORDER BY r.approved_at DESC`,
    req.staff.branch_id, date,
  ));
});

r.get('/pending', (req, res) => {
  res.json(all(
    `SELECT r.id, r.kind, r.cp, r.value_paise, r.status, r.approved_at, c.mobile, c.name customer_name, o.title offer_title
       FROM redemptions r JOIN customers c ON c.id = r.customer_id LEFT JOIN offers o ON o.id = r.offer_id
      WHERE r.branch_id = ? AND r.status IN ('APPROVED','SUBMITTED','BILLED') ORDER BY r.approved_at DESC LIMIT 200`,
    req.staff.branch_id,
  ));
});

r.get('/report', requirePerm('counter.report'), (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : istDate();
  res.json(managerDaily(req.staff.branch_id, date));
});

export default r;
