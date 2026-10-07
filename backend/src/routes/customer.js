import { Router } from 'express';
import QRCode from 'qrcode';
import { all, get, run } from '../db.js';
import { customerQrPayload, requireCustomer } from '../auth.js';
import { customerCard, savings } from '../customers.js';
import { storeDirectory } from '../contact.js';
import { attachmentView } from '../media.js';
import { challengesFor } from '../challenges.js';
import { applyReferral, currentProgram, programSummary, referralCode, refereeEligibility } from '../referrals.js';
import { activeRedeemBusinesses, businessView, pointsCap, ruleLines, ruleOf } from '../businesses.js';
import { offersForCustomer } from '../offers.js';
import { cancelOrReverse, createRequest, expireStale, redemptionQrPayload } from '../redemptions.js';
import { audit, customerActor } from '../audit.js';
import { HttpError, bad, fmtPoints, isDate, istDate, nowIso, parsePointsInput } from '../util.js';

const r = Router();
r.use(requireCustomer);

export const qrSvg = (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

r.get('/', (req, res) => {
  const c = req.customer;
  const offers = offersForCustomer(c);
  res.json({
    customer: customerCard(c),
    savings: savings(c.id),
    offers,
    unread: get('SELECT COUNT(*) n FROM notifications WHERE customer_id = ? AND read_at IS NULL', c.id).n,
  });
});

function specialDate(v, label) {
  if (!v) return null;
  if (!isDate(v) || v > istDate()) throw bad(`Invalid ${label}`);
  return v;
}

r.put('/', (req, res) => {
  const c = req.customer;
  const name = String(req.body?.name ?? '').trim().slice(0, 80) || null;
  const dob = specialDate(req.body?.dob, 'date of birth');
  const anniversary = specialDate(req.body?.anniversary, 'anniversary date');
  if (!name) throw bad('Please enter your name');
  // These dates drive birthday / anniversary rewards, so once set only the store can change them.
  if (c.dob && dob && dob !== c.dob) throw bad('Date of birth is already set. Please contact the store to change it.');
  if (c.anniversary && anniversary && anniversary !== c.anniversary) throw bad('Anniversary date is already set. Please contact the store to change it.');
  if (!(c.dob || dob) && !(c.anniversary || anniversary)) throw bad('Please enter your date of birth or wedding anniversary');
  run('UPDATE customers SET name = ?, dob = COALESCE(dob, ?), anniversary = COALESCE(anniversary, ?) WHERE id = ?', name, dob, anniversary, c.id);
  audit(customerActor(c), 'PROFILE_UPDATED', 'customer', c.id, { name, dob, anniversary }, req.ip);
  res.json({ customer: customerCard(get('SELECT * FROM customers WHERE id = ?', c.id)) });
});

r.get('/qr', async (req, res) => {
  const q = customerQrPayload(req.customer.code);
  res.json({ ...q, code: req.customer.code, svg: await qrSvg(q.payload) });
});

r.get('/ledger', (req, res) => {
  res.json(all(
    `SELECT l.id, l.type, l.cp, l.balance_after_cp, l.note, l.created_at, l.redemption_id, b.name branch, p.bill_date
       FROM points_ledger l LEFT JOIN branches b ON b.id = l.branch_id LEFT JOIN purchases p ON p.id = l.purchase_id
      WHERE l.customer_id = ? ORDER BY l.id DESC LIMIT 200`,
    req.customer.id,
  ));
});

r.get('/purchases', (req, res) => {
  res.json(all(
    `SELECT p.id, p.bill_no, p.bill_date, p.bill_time, p.bill_type, p.bill_value_paise, p.discount_paise, p.net_paise, p.credited_cp, p.reversed_cp,
            b.name branch, (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = p.id) items
       FROM purchases p JOIN branches b ON b.id = p.branch_id
      WHERE p.customer_id = ? ORDER BY p.bill_date DESC, p.bill_time DESC LIMIT 200`,
    req.customer.id,
  ));
});

r.get('/purchases/:id', (req, res) => {
  const p = get('SELECT p.*, b.name branch FROM purchases p JOIN branches b ON b.id = p.branch_id WHERE p.id = ? AND p.customer_id = ?', req.params.id, req.customer.id);
  if (!p) throw new HttpError(404, 'Bill not found');
  res.json({ ...p, items: all('SELECT product_name, product_code, category, qty, rate_paise, discount_paise, amount_paise FROM purchase_items WHERE purchase_id = ?', p.id) });
});

r.get('/offers', (req, res) => res.json(offersForCustomer(req.customer)));

/**
 * Rewards Marketplace: every business where points / rewards can be used, with its rules,
 * how much of the customer's balance can be used there, and the rewards on offer.
 */
r.get('/marketplace', (req, res) => {
  const c = req.customer;
  const avail = offersForCustomer(c);
  const rewards = [...avail.forYou, ...avail.everyone].filter((o) => o.redeemable);
  const businesses = activeRedeemBusinesses().map((b) => {
    const rule = ruleOf(b.id);
    const cap = pointsCap({ rule, balanceCp: c.balance_cp });
    const reasons = [];
    if (rule.min_points_cp && c.balance_cp < rule.min_points_cp) reasons.push(`Collect at least ${fmtPoints(rule.min_points_cp)} points to redeem here`);
    if (cap.maxCp <= 0) reasons.push('No points available yet');
    return {
      ...businessView(b),
      can_use_points: !reasons.length,
      reasons,
      max_cp_now: Math.max(0, cap.maxCp),
      max_paise_now: Math.max(0, cap.maxPaise),
      rewards: rewards.filter((o) => o.business_id === b.id),
    };
  });
  res.json({
    balance_cp: c.balance_cp,
    // unlocked personal rewards (coupons) across all businesses, shown first
    coupons: avail.forYou.filter((o) => o.redeemable),
    businesses,
  });
});

/** Spend milestones and visit challenges with live progress for the current period. */
r.get('/challenges', (req, res) => res.json(challengesFor(req.customer)));

/** Refer a friend: my code, programme terms, my referrals, and whether I can still enter a code myself. */
r.get('/referral', (req, res) => {
  const c = req.customer;
  const p = currentProgram();
  const mine = all(
    `SELECT r.status, r.created_at, r.qualified_at, b.name, b.mobile FROM referrals r JOIN customers b ON b.id = r.referee_id
      WHERE r.referrer_id = ? ORDER BY r.id DESC LIMIT 50`, c.id,
  ).map((x) => ({ status: x.status, created_at: x.created_at, qualified_at: x.qualified_at, friend: x.name || `${x.mobile.slice(0, 2)}XXXXXX${x.mobile.slice(-2)}` }));
  const applied = get('SELECT r.status, r.created_at, a.name referrer_name FROM referrals r JOIN customers a ON a.id = r.referrer_id WHERE r.referee_id = ?', c.id);
  res.json({
    program: programSummary(p),
    code: p ? referralCode(c) : c.referral_code,
    referrals: mine,
    applied: applied || null,
    can_apply: refereeEligibility(c, p),
  });
});
r.post('/referral', (req, res) => {
  const x = applyReferral(req.customer, req.body?.code, req.ip);
  res.json({ ok: true, status: x.status });
});

/** Branch addresses, phone / WhatsApp / map links and customer care. */
r.get('/stores', (req, res) => res.json(storeDirectory()));

r.get('/redemptions', (req, res) => {
  expireStale();
  res.json(all(
    `SELECT r.id, r.kind, r.cp, r.value_paise, r.status, r.created_at, r.approved_at, r.expires_at, r.cancel_reason, b.name branch, bz.name business, o.title offer_title
       FROM redemptions r LEFT JOIN branches b ON b.id = r.branch_id LEFT JOIN offers o ON o.id = r.offer_id LEFT JOIN businesses bz ON bz.id = r.business_id
      WHERE r.customer_id = ? ORDER BY r.created_at DESC LIMIT 100`,
    req.customer.id,
  ));
});

/** Customer asks to redeem; returns a one-time QR the manager scans. */
r.post('/redemptions', async (req, res) => {
  const { kind, points, offerId, businessId } = req.body || {};
  const red = createRequest({
    customerId: req.customer.id,
    kind,
    cp: kind === 'POINTS' ? parsePointsInput(points) : 0,
    offerId,
    businessId: businessId ? Number(businessId) : null,
    via: 'APP',
  });
  audit(customerActor(req.customer), 'REDEMPTION_REQUESTED', 'redemption', red.id, { kind, cp: red.cp, value_paise: red.value_paise }, req.ip);
  const payload = redemptionQrPayload(red);
  const biz = get('SELECT name FROM businesses WHERE id = ?', red.business_id);
  const rule = ruleOf(red.business_id);
  res.json({
    id: red.id, kind: red.kind, points: fmtPoints(red.cp), cp: red.cp, value_paise: red.value_paise, business: biz?.name,
    rule_lines: ruleLines(rule),
    expires_at: red.expires_at, status: red.status, payload, svg: await qrSvg(payload),
  });
});

r.get('/redemptions/:id/status', (req, res) => {
  expireStale();
  const x = get('SELECT id, status, approved_at, cancel_reason FROM redemptions WHERE id = ? AND customer_id = ?', req.params.id, req.customer.id);
  if (!x) throw new HttpError(404, 'Not found');
  res.json(x);
});

r.post('/redemptions/:id/cancel', (req, res) => {
  cancelOrReverse(req.params.id, { type: 'CUSTOMER', id: req.customer.id, name: req.customer.mobile }, 'Customer changed mind', 'Cancelled in app', req.ip);
  res.json({ ok: true });
});

r.get('/notifications', (req, res) => {
  const rows = all(
    `SELECT n.id, n.kind, n.title, n.body, n.created_at, n.read_at, n.offer_id, o.attachment_file, o.attachment_type, o.attachment_name
       FROM notifications n LEFT JOIN offers o ON o.id = n.offer_id WHERE n.customer_id = ? ORDER BY n.id DESC LIMIT 50`,
    req.customer.id,
  ).map(({ attachment_file, attachment_type, attachment_name, ...n }) => ({ ...n, attachment: attachmentView({ attachment_file, attachment_type, attachment_name }) }));
  run('UPDATE notifications SET read_at = ? WHERE customer_id = ? AND read_at IS NULL', nowIso(), req.customer.id);
  res.json(rows);
});

export default r;
