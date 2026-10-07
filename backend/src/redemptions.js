import { CONFIG } from './config.js';
import { all, get, nextCounter, run, setting, tx } from './db.js';
import { postLedger } from './points.js';
import { assertOfferRedeemable, offerConditions } from './offers.js';
import { audit, notify } from './audit.js';
import { businessOfBranch, checkRedemptionRules, getBusiness, minBillFor, ownerBusiness, ruleLines, ruleOf } from './businesses.js';
import { recordRedemption, recordReversal } from './settlement.js';
import { HttpError, bad, cpToPaise, fmtPoints, fmtRupees, istDate, istFriendly, maskMobile, nowIso, randomToken, toPaise } from './util.js';

/**
 * Lifecycle:  CREATED → APPROVED → SUBMITTED → BILLED → RECONCILED
 * Side exits: CREATED → CANCELLED | EXPIRED
 *             APPROVED/SUBMITTED(/BILLED by admin) → REVERSED (points restored)
 */
export const OPEN = ['APPROVED', 'SUBMITTED'];
export const CANCEL_REASONS = ['Customer changed mind', 'Billing cancelled', 'Wrong redemption amount', 'Duplicate transaction', 'Other'];

function newRedemptionId() {
  const d = istDate().replace(/-/g, '').slice(2); // YYMMDD
  const n = nextCounter(`VR-${d}`, 1001);
  return `VR-${d}-${n}`;
}

function event(id, from, to, actor, branchId, note) {
  run(
    'INSERT INTO redemption_events(redemption_id, from_status, to_status, actor_type, actor_id, branch_id, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
    id, from, to, actor.type, actor.id ?? null, branchId ?? null, note ?? null, nowIso(),
  );
}

export function expireStale() {
  const now = nowIso();
  const rows = all("SELECT id FROM redemptions WHERE status = 'CREATED' AND expires_at < ?", now);
  for (const r of rows) {
    run("UPDATE redemptions SET status = 'EXPIRED', token = NULL WHERE id = ? AND status = 'CREATED'", r.id);
    event(r.id, 'CREATED', 'EXPIRED', { type: 'SYSTEM' }, null, 'Token validity elapsed');
  }
}

function validatePointsAmount(customer, cp) {
  const min = Math.round(setting('min_redeem_points') * 100);
  const max = Math.round(setting('max_redeem_points') * 100);
  if (cp <= 0) throw bad('Enter points to redeem');
  if (cp < min) throw bad(`Minimum redemption is ${fmtPoints(min)} points`);
  if (max > 0 && cp > max) throw bad(`Maximum per redemption is ${fmtPoints(max)} points`);
  if (cp > customer.balance_cp) throw bad(`Insufficient points. Available: ${fmtPoints(Math.max(0, customer.balance_cp))}`);
}

/** Parse a bill amount typed by the manager (₹). Blank -> null. */
export function billAmount(v) {
  if (v === undefined || v === null || v === '') return null;
  const p = toPaise(v);
  if (p == null || !(p > 0)) throw bad('Enter a valid bill amount');
  return p;
}

/**
 * Create a redemption request for one business. The customer never supplies a ₹ value:
 * it is always computed on the server from points or from the reward.
 * Business rules are checked here as far as possible without a bill, and again in full at approval.
 */
export function createRequest({ customerId, kind, cp, offerId, via, verifiedBy = null, branchId = null, businessId = null }) {
  return tx(() => {
    expireStale();
    const c = get('SELECT * FROM customers WHERE id = ?', customerId);
    if (!c || c.status !== 'ACTIVE') throw bad('Customer account is not active');
    const business = businessId ? getBusiness(Number(businessId)) : branchId ? businessOfBranch(branchId) : null;
    let value = 0;
    let offer = null;
    if (kind === 'OFFER') {
      offer = assertOfferRedeemable(c, Number(offerId), branchId, business?.id ?? null);
      value = offer.value_paise;
      cp = offer.points_cost_cp || 0;
    } else if (kind === 'POINTS') {
      validatePointsAmount(c, cp);
      value = cpToPaise(cp);
    } else throw bad('Invalid redemption type');
    const biz = business || (offer ? getBusiness(offer.business_id) : ownerBusiness());
    if (!biz) throw bad('Business not found');
    checkRedemptionRules({ business: biz, rule: ruleOf(biz.id), branchId, kind, cp, offer, balanceCp: c.balance_cp, atApproval: false });

    // One open request per customer: a newer request supersedes the older one.
    for (const r of all("SELECT id FROM redemptions WHERE customer_id = ? AND status = 'CREATED'", c.id)) {
      run("UPDATE redemptions SET status = 'CANCELLED', token = NULL, cancelled_at = ?, cancel_reason = 'Superseded by a newer request' WHERE id = ?", nowIso(), r.id);
      event(r.id, 'CREATED', 'CANCELLED', { type: 'SYSTEM' }, null, 'Superseded by a newer request');
    }

    const id = newRedemptionId();
    const token = randomToken(18);
    run(
      `INSERT INTO redemptions(id, token, kind, customer_id, offer_id, business_id, cp, value_paise, status, requested_via, verified_by, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,'CREATED',?,?,?,?)`,
      id, token, kind, c.id, offer?.id ?? null, biz.id, cp, value, via, verifiedBy, nowIso(),
      new Date(Date.now() + CONFIG.redemptionTokenValiditySec * 1000).toISOString(),
    );
    event(id, null, 'CREATED', via === 'APP' ? { type: 'CUSTOMER', id: c.id } : { type: 'MANAGER', id: null }, branchId, `Requested via ${via}`);
    return get('SELECT * FROM redemptions WHERE id = ?', id);
  });
}

export const redemptionQrPayload = (r) => `VR1.${r.token}`;

export function findByToken(payload) {
  const m = /^VR1\.([A-Za-z0-9_-]{16,})$/.exec(String(payload).trim());
  if (!m) return null;
  expireStale();
  const r = get('SELECT * FROM redemptions WHERE token = ?', m[1]);
  if (!r) throw bad('Redemption QR is invalid or has already been used');
  return r;
}

/**
 * Manager approval. Atomic: re-checks status, expiry, balance and the business's
 * redemption rules inside the transaction, then deducts points immediately, so the
 * same points can't be approved twice at two outlets.
 *
 * opts.billPaise — the customer's bill (needed for % limits and minimum-bill rules)
 * opts.cp        — approve fewer points than requested (e.g. capped at 20% of the bill)
 */
export function approve(redemptionId, staff, ip, { billPaise = null, cp: approveCp = null } = {}) {
  return tx(() => {
    expireStale();
    const r = get('SELECT * FROM redemptions WHERE id = ?', redemptionId);
    if (!r) throw new HttpError(404, 'Redemption not found');
    if (r.status !== 'CREATED') throw bad(`Redemption is already ${r.status.toLowerCase()}`);
    const c = get('SELECT * FROM customers WHERE id = ?', r.customer_id);
    if (c.status !== 'ACTIVE') throw bad('Customer account is blocked');
    const business = businessOfBranch(staff.branch_id);
    const target = getBusiness(r.business_id) || ownerBusiness();
    if (target.id !== business.id) throw bad(`This request is for ${target.name}. It can only be approved at a ${target.name} outlet.`);
    const rule = ruleOf(business.id);
    const actor = { type: staff.role, id: staff.id };

    let offer = null;
    if (r.kind === 'POINTS' && approveCp != null) {
      if (!Number.isInteger(approveCp) || approveCp <= 0) throw bad('Enter the points to approve');
      if (approveCp > r.cp) throw bad('You can approve fewer points than requested, not more');
      if (approveCp !== r.cp) {
        r.cp = approveCp;
        r.value_paise = cpToPaise(approveCp);
      }
    }
    if (r.kind === 'OFFER') offer = assertOfferRedeemable(c, r.offer_id, staff.branch_id, business.id);
    checkRedemptionRules({ business, rule, branchId: staff.branch_id, kind: r.kind, cp: r.cp, offer, billPaise, balanceCp: c.balance_cp, atApproval: true });

    if (r.cp > 0) {
      postLedger({ customerId: c.id, type: 'REDEEM', cp: -r.cp, branchId: staff.branch_id, redemptionId: r.id, offerId: r.offer_id,
        note: r.kind === 'POINTS' ? `Points redeemed at ${business.name}` : `Reward "${offer.title}" at ${business.name}`, actor });
    }
    const funding = recordRedemption(r, offer, business);
    const now = nowIso();
    run(
      `UPDATE redemptions SET status = 'APPROVED', token = NULL, cp = ?, value_paise = ?, bill_paise = ?, branch_id = ?, approved_by = ?, approved_at = ?,
         reward_cost_paise = ?, program_funded_paise = ?, partner_funded_paise = ? WHERE id = ?`,
      r.cp, r.value_paise, billPaise, staff.branch_id, staff.id, now,
      funding.reward_cost_paise, funding.program_funded_paise, funding.partner_funded_paise, r.id,
    );
    event(r.id, 'CREATED', 'APPROVED', actor, staff.branch_id, billPaise != null ? `Bill ${fmtRupees(billPaise)}` : null);
    audit({ type: staff.role, id: staff.id, name: staff.name, branch_id: staff.branch_id }, 'REDEMPTION_APPROVED', 'redemption', r.id,
      { kind: r.kind, business: business.code, cp: r.cp, value_paise: r.value_paise, bill_paise: billPaise, customer_id: c.id }, ip);
    const where = business.is_program_owner ? staff.branch_name : `${business.name}, ${staff.branch_name}`;
    notify(c.id, 'REDEMPTION', 'Redemption approved',
      r.kind === 'POINTS'
        ? `${fmtPoints(r.cp)} points (${fmtRupees(r.value_paise)}) redeemed at ${where}. Ref ${r.id}.`
        : `${offer.title} redeemed at ${where}${r.cp ? ` for ${fmtPoints(r.cp)} points` : ''}. Ref ${r.id}.`);
    return get('SELECT * FROM redemptions WHERE id = ?', r.id);
  });
}

/**
 * Partner outlets that don't send a daily Excel file confirm the bill in the Manager Panel.
 * That completes the redemption (BILLED → RECONCILED) and makes it settleable.
 */
export function confirmPartnerBill(redemptionId, staff, { billNo, billPaise }, ip) {
  billNo = String(billNo || '').trim().slice(0, 40);
  if (!billNo) throw bad('Enter the bill number');
  return tx(() => {
    const r = get('SELECT * FROM redemptions WHERE id = ?', redemptionId);
    if (!r) throw new HttpError(404, 'Redemption not found');
    if (r.branch_id !== staff.branch_id) throw new HttpError(403, 'Redemption belongs to another outlet');
    const business = getBusiness(r.business_id);
    if (business.billing_source !== 'MANAGER') throw bad(`${business.name} bills are matched from the daily Excel upload`);
    if (!['APPROVED', 'SUBMITTED'].includes(r.status)) throw bad(`Cannot confirm a ${r.status.toLowerCase()} redemption`);
    const bill = billPaise ?? r.bill_paise;
    if (bill == null) throw bad('Enter the final bill amount');
    const offer = r.offer_id ? get('SELECT * FROM offers WHERE id = ?', r.offer_id) : null;
    const minBill = minBillFor(ruleOf(business.id), offer);
    if (bill < minBill) throw bad(`Minimum bill for this redemption is ${fmtRupees(minBill)}`);
    const now = nowIso();
    const actor = { type: staff.role, id: staff.id };
    run("UPDATE redemptions SET status = 'RECONCILED', partner_bill_no = ?, bill_paise = ?, billed_at = ?, reconciled_at = ?, recon_status = 'MANAGER_CONFIRMED' WHERE id = ?",
      billNo, bill, now, now, r.id);
    event(r.id, r.status, 'BILLED', actor, staff.branch_id, `Bill ${billNo} · ${fmtRupees(bill)}`);
    event(r.id, 'BILLED', 'RECONCILED', actor, staff.branch_id, 'Confirmed by outlet manager');
    audit({ type: staff.role, id: staff.id, name: staff.name, branch_id: staff.branch_id }, 'PARTNER_BILL_CONFIRMED', 'redemption', r.id, { bill_no: billNo, bill_paise: bill }, ip);
    return get('SELECT * FROM redemptions WHERE id = ?', r.id);
  });
}

export function markSubmitted(redemptionId, staff) {
  return tx(() => {
    const r = get('SELECT * FROM redemptions WHERE id = ?', redemptionId);
    if (!r) throw new HttpError(404, 'Redemption not found');
    if (staff.role === 'MANAGER' && r.branch_id !== staff.branch_id) throw new HttpError(403, 'Redemption belongs to another branch');
    if (r.status === 'SUBMITTED') return r;
    if (r.status !== 'APPROVED') throw bad(`Cannot submit a ${r.status.toLowerCase()} redemption`);
    run("UPDATE redemptions SET status = 'SUBMITTED', submitted_at = ? WHERE id = ?", nowIso(), r.id);
    event(r.id, 'APPROVED', 'SUBMITTED', { type: staff.role, id: staff.id }, staff.branch_id, 'Receipt handed to customer for billing');
    return get('SELECT * FROM redemptions WHERE id = ?', r.id);
  });
}

/** Cancel (before approval) or reverse (after approval, points restored). Reason mandatory. */
export function cancelOrReverse(redemptionId, actor, reason, note, ip) {
  reason = String(reason || '').trim();
  note = String(note || '').trim();
  if (!reason) throw bad('A reason is required');
  if (reason === 'Other' && !note) throw bad('Please describe the reason');
  const fullReason = note ? `${reason}: ${note}` : reason;
  return tx(() => {
    const r = get('SELECT * FROM redemptions WHERE id = ?', redemptionId);
    if (!r) throw new HttpError(404, 'Redemption not found');
    const isAdmin = actor.type === 'ADMIN';
    const isCustomer = actor.type === 'CUSTOMER';
    if (isCustomer && (r.customer_id !== actor.id || r.status !== 'CREATED')) throw new HttpError(403, 'Only your own pending requests can be cancelled');
    if (actor.type === 'MANAGER' && r.status !== 'CREATED' && r.branch_id !== actor.branch_id) throw new HttpError(403, 'Only the approving branch or admin can reverse this redemption');

    const now = nowIso();
    let to;
    if (r.status === 'CREATED') {
      to = 'CANCELLED';
    } else if (OPEN.includes(r.status) || (isAdmin && ['BILLED', 'RECONCILED'].includes(r.status))) {
      to = 'REVERSED';
      if (r.cp > 0) {
        postLedger({ customerId: r.customer_id, type: 'REDEEM_REVERSAL', cp: r.cp, branchId: r.branch_id, redemptionId: r.id, note: `Redemption reversed: ${fullReason}`, actor });
        notify(r.customer_id, 'POINTS_REVERSED', 'Points restored', `${fmtPoints(r.cp)} points from redemption ${r.id} were returned to your balance.`);
      }
      recordReversal(r.id, fullReason);
    } else if (['BILLED', 'RECONCILED'].includes(r.status)) {
      throw bad('This redemption has already been billed. Only an admin can reverse it.');
    } else {
      throw bad(`Redemption is already ${r.status.toLowerCase()}`);
    }
    run('UPDATE redemptions SET status = ?, token = NULL, cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?',
      to, now, isCustomer ? null : actor.id, fullReason, r.id);
    event(r.id, r.status, to, actor, actor.branch_id, fullReason);
    audit(actor, to === 'CANCELLED' ? 'REDEMPTION_CANCELLED' : 'REDEMPTION_REVERSED', 'redemption', r.id, { from: r.status, reason: fullReason, cp: r.cp, value_paise: r.value_paise }, ip);
    return get('SELECT * FROM redemptions WHERE id = ?', r.id);
  });
}

/** Everything the manager panel needs to print the slip. */
export function receipt(redemptionId) {
  const r = get(
    `SELECT r.*, c.mobile, c.name customer_name, c.code customer_code, b.name branch_name, b.code branch_code,
            s.name approved_by_name, o.title offer_title, o.type offer_type, o.min_spend_paise, o.category, o.product, o.bonus_cp, o.multiplier,
            o.coupon_code, o.points_cost_cp, bz.name business_name, bz.code business_code, bz.billing_source, bz.is_program_owner
       FROM redemptions r
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN branches b ON b.id = r.branch_id
       LEFT JOIN staff s ON s.id = r.approved_by
       LEFT JOIN offers o ON o.id = r.offer_id
       LEFT JOIN businesses bz ON bz.id = r.business_id
      WHERE r.id = ?`,
    redemptionId,
  );
  if (!r) throw new HttpError(404, 'Redemption not found');
  const rule = ruleOf(r.business_id);
  const minBill = minBillFor(rule, r.offer_id ? r : null);
  return {
    id: r.id,
    status: r.status,
    kind: r.kind,
    type_label: r.kind === 'POINTS' ? 'Points redemption' : r.points_cost_cp ? 'Points reward' : 'Promotional reward / coupon',
    customer_mobile_masked: maskMobile(r.mobile),
    customer_name: r.customer_name,
    customer_code: r.customer_code,
    business: r.business_name,
    business_code: r.business_code,
    business_is_owner: !!r.is_program_owner,
    billing_source: r.billing_source,
    branch: r.branch_name,
    points: r.cp ? fmtPoints(r.cp) : null,
    value: fmtRupees(r.value_paise),
    value_paise: r.value_paise,
    offer: r.offer_title || null,
    coupon_code: r.coupon_code || null,
    offer_conditions: r.offer_id ? offerConditions({ ...r, type: r.offer_type, points_cost_cp: r.points_cost_cp }) : null,
    rule_lines: ruleLines(rule),
    min_bill: minBill ? fmtRupees(minBill) : null,
    bill: r.bill_paise != null ? fmtRupees(r.bill_paise) : null,
    partner_bill_no: r.partner_bill_no,
    approved_by: r.approved_by_name,
    approved_at: r.approved_at ? istFriendly(r.approved_at) : null,
    created_at: istFriendly(r.created_at),
    cancel_reason: r.cancel_reason,
    events: all('SELECT from_status, to_status, actor_type, note, created_at FROM redemption_events WHERE redemption_id = ? ORDER BY id', r.id),
  };
}
