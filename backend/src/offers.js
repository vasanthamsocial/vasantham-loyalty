import { all, get } from './db.js';
import { bad, fmtPoints, isDate, istDate, toPaise, parsePointsInput } from './util.js';
import { attachmentView, logoUrl } from './media.js';

export const OFFER_TYPES = {
  SPEND_GET_OFF: { label: 'Spend ₹X, get ₹Y off', redeemable: true },
  CATEGORY_OFFER: { label: 'Product / category offer', redeemable: true },
  FREE_PRODUCT: { label: 'Free product', redeemable: true },
  PERSONAL_DISCOUNT: { label: 'Personalised discount', redeemable: true, personalOnly: true },
  BIRTHDAY: { label: 'Birthday reward', redeemable: true },
  COMEBACK: { label: 'Comeback offer', redeemable: true, personalOnly: true },
  COUPON: { label: 'Coupon / voucher (₹ off)', redeemable: true },
  BONUS_POINTS: { label: 'Bonus points', redeemable: false },
  MULTIPLIER: { label: 'Multiple points', redeemable: false },
};

/** Validate & normalise admin input into an offers row (without id). */
/** Who pays for a reward. PROGRAM = loyalty fund, PARTNER = the partner business, SHARED = split. */
export const FUNDING_TYPES = { PROGRAM: 'Vasantham loyalty fund', PARTNER: 'Partner business', SHARED: 'Shared (partner pays a fixed part)' };

export function normaliseOffer(b) {
  const t = OFFER_TYPES[b.type];
  if (!t) throw bad('Unknown offer type');
  const title = String(b.title || '').trim();
  if (!title) throw bad('Title is required');
  const audience = t.personalOnly ? 'PERSONAL' : b.audience === 'PERSONAL' ? 'PERSONAL' : 'GLOBAL';
  if (!isDate(b.valid_from) || !isDate(b.valid_to) || b.valid_to < b.valid_from) throw bad('Valid from/to dates are invalid');
  const o = {
    title,
    description: String(b.description || '').trim() || null,
    type: b.type,
    audience,
    coupon_code: String(b.coupon_code || '').trim().toUpperCase() || null,
    min_spend_paise: toPaise(b.min_spend) ?? 0,
    value_paise: toPaise(b.value) ?? 0,
    category: String(b.category || '').trim() || null,
    product: String(b.product || '').trim() || null,
    bonus_cp: 0,
    multiplier: null,
    valid_from: b.valid_from,
    valid_to: b.valid_to,
    max_uses_per_customer: Math.max(1, parseInt(b.max_uses_per_customer || 1, 10) || 1),
    branch_ids: Array.isArray(b.branch_ids) && b.branch_ids.length ? b.branch_ids.map(Number).join(',') : null,
    active: b.active === false || b.active === 0 ? 0 : 1,
  };
  if (o.min_spend_paise < 0 || o.value_paise < 0) throw bad('Amounts cannot be negative');
  if (t.redeemable && o.value_paise <= 0) throw bad('Offer value (₹) is required — it is the discount / cost given at billing');
  if (b.type === 'CATEGORY_OFFER' && !o.category && !o.product) throw bad('Category or product is required');
  if (b.type === 'FREE_PRODUCT' && !o.product) throw bad('Free product name is required');
  if (b.type === 'BONUS_POINTS') {
    o.bonus_cp = parsePointsInput(b.bonus_points);
    if (!o.bonus_cp) throw bad('Bonus points are required');
  }
  if (b.type === 'MULTIPLIER') {
    o.multiplier = Number(b.multiplier);
    if (!(o.multiplier > 1 && o.multiplier <= 10)) throw bad('Multiplier must be between 1 and 10 (e.g. 2 for double points)');
  }

  // --- ecosystem fields: where the reward is used, what it costs and who funds it ---
  const owner = get('SELECT * FROM businesses WHERE is_program_owner = 1 ORDER BY id LIMIT 1');
  const biz = b.business_id ? get('SELECT * FROM businesses WHERE id = ?', Number(b.business_id)) : owner;
  if (!biz) throw bad('Choose the business where this offer is used');
  o.business_id = biz.id;
  if (!t.redeemable && !biz.can_earn) throw bad(`${biz.name} does not earn points, so bonus / multiplier offers can't run there`);
  if (o.branch_ids) {
    const own = new Set(all('SELECT id FROM branches WHERE business_id = ?', biz.id).map((r) => r.id));
    if (o.branch_ids.split(',').map(Number).some((id) => !own.has(id))) throw bad(`Selected branches must be outlets of ${biz.name}`);
  }
  o.points_cost_cp = b.points_cost === '' || b.points_cost == null ? 0 : parsePointsInput(b.points_cost);
  if (o.points_cost_cp && !t.redeemable) throw bad('Only rewards redeemed at the counter can cost points');
  o.cost_paise = b.cost === '' || b.cost == null ? null : toPaise(b.cost);
  if (o.cost_paise != null && o.cost_paise < 0) throw bad('Internal cost cannot be negative');
  o.terms = String(b.terms || '').trim().slice(0, 2000) || null;
  const targets = Array.isArray(b.target_segments) ? b.target_segments.map((x) => String(x).trim()).filter(Boolean) : [];
  o.target_segments = o.audience === 'GLOBAL' && targets.length ? [...new Set(targets)].join(',') : null;
  o.funding_type = String(b.funding_type || 'PROGRAM').toUpperCase();
  if (!FUNDING_TYPES[o.funding_type]) throw bad('Choose who funds this reward');
  o.funder_business_id = null;
  o.partner_share_paise = 0;
  if (o.funding_type !== 'PROGRAM') {
    const funder = b.funder_business_id ? get('SELECT * FROM businesses WHERE id = ?', Number(b.funder_business_id)) : biz;
    if (!funder || funder.is_program_owner) throw bad('Partner funding needs a partner business (not the loyalty program owner)');
    o.funder_business_id = funder.id;
    if (o.funding_type === 'SHARED') {
      o.partner_share_paise = toPaise(b.partner_share) ?? 0;
      const cost = o.cost_paise ?? o.value_paise;
      if (!(o.partner_share_paise > 0 && o.partner_share_paise < cost)) throw bad('Partner share must be more than ₹0 and less than the reward cost');
    }
  }
  return o;
}

/** How a redeemed reward's cost is split between the loyalty fund and a partner. */
export function rewardFunding(o) {
  const cost = o.cost_paise ?? o.value_paise;
  if (o.funding_type === 'PARTNER') return { cost, program: 0, partner: cost, funderId: o.funder_business_id };
  if (o.funding_type === 'SHARED') return { cost, program: cost - o.partner_share_paise, partner: o.partner_share_paise, funderId: o.funder_business_id };
  return { cost, program: cost, partner: 0, funderId: null };
}

/** Cross-business targeting: a global offer with target segments is shown only to customers in one of them. */
export const customerSegmentSet = (customerId) => new Set(all('SELECT segment FROM customer_segments WHERE customer_id = ?', customerId).map((r) => r.segment));
const targetOk = (o, segs) => o.audience !== 'GLOBAL' || !o.target_segments || o.target_segments.split(',').some((t) => segs.has(t));

const branchOk = (o, branchId) => !o.branch_ids || !branchId || o.branch_ids.split(',').map(Number).includes(Number(branchId));

function usesOf(offerId, customerId) {
  const r = get(
    `SELECT COUNT(*) n FROM redemptions WHERE offer_id = ? AND customer_id = ?
       AND status IN ('APPROVED','SUBMITTED','BILLED','RECONCILED')`,
    offerId, customerId,
  ).n;
  const l = get("SELECT COUNT(DISTINCT purchase_id) n FROM points_ledger WHERE offer_id = ? AND customer_id = ? AND type = 'BONUS'", offerId, customerId).n;
  return r + l;
}

/**
 * All offers currently available to a customer, split into
 * "Offers for Everyone" and "Offers for You".
 */
export function offersForCustomer(customer, { branchId = null, businessId = null, date = istDate() } = {}) {
  const rows = all(
    `SELECT o.*, a.expires_on AS assigned_expires_on, a.id AS assignment_id, a.uses_allowed,
            bz.name AS business_name, bz.code AS business_code, bz.logo_file AS business_logo, bz.is_program_owner AS business_is_owner, bz.can_redeem AS business_can_redeem
       FROM offers o
       JOIN businesses bz ON bz.id = o.business_id AND bz.active = 1 AND (bz.offer_participation = 1 OR bz.is_program_owner = 1)
       LEFT JOIN offer_assignments a ON a.offer_id = o.id AND a.customer_id = ?
      WHERE o.active = 1 AND o.valid_from <= ? AND o.valid_to >= ?
        AND (? IS NULL OR o.business_id = ?)
        AND (o.audience = 'GLOBAL' OR (a.id IS NOT NULL AND (a.expires_on IS NULL OR a.expires_on >= ?)))
      ORDER BY bz.is_program_owner DESC, o.valid_to`,
    customer.id, date, date, businessId, businessId, date,
  );
  const everyone = [];
  const forYou = [];
  const segs = customerSegmentSet(customer.id);
  const birthMonth = customer.dob ? customer.dob.slice(5, 7) : null;
  for (const o of rows) {
    if (!branchOk(o, branchId)) continue;
    if (OFFER_TYPES[o.type]?.redeemable && !o.business_can_redeem) continue;
    if (!targetOk(o, segs)) continue;
    if (o.type === 'BIRTHDAY' && birthMonth !== date.slice(5, 7)) continue;
    const used = usesOf(o.id, customer.id);
    const usesLeft = Math.max(0, (o.uses_allowed ?? o.max_uses_per_customer) - used);
    if (usesLeft === 0) continue;
    const view = offerView(o, { usesLeft, validTo: o.assigned_expires_on && o.assigned_expires_on < o.valid_to ? o.assigned_expires_on : o.valid_to });
    (o.audience === 'PERSONAL' || o.type === 'BIRTHDAY' ? forYou : everyone).push(view);
  }
  return { everyone, forYou };
}

export function offerView(o, extra = {}) {
  return {
    id: o.id,
    title: o.title,
    description: o.description,
    type: o.type,
    type_label: OFFER_TYPES[o.type]?.label,
    audience: o.audience,
    coupon_code: o.coupon_code,
    min_spend_paise: o.min_spend_paise,
    value_paise: o.value_paise,
    category: o.category,
    product: o.product,
    bonus_cp: o.bonus_cp,
    multiplier: o.multiplier,
    valid_from: o.valid_from,
    valid_to: extra.validTo || o.valid_to,
    redeemable: !!OFFER_TYPES[o.type]?.redeemable,
    uses_left: extra.usesLeft,
    conditions: offerConditions(o),
    business_id: o.business_id,
    business_name: o.business_name,
    business_code: o.business_code,
    business_logo_url: logoUrl(o.business_logo),
    business_is_owner: !!o.business_is_owner,
    // POINTS = costs points (points redemption reward); PROMO = promotional unlock, no points needed
    reward_class: o.points_cost_cp > 0 ? 'POINTS' : 'PROMO',
    points_cost_cp: o.points_cost_cp || 0,
    points_cost: o.points_cost_cp ? fmtPoints(o.points_cost_cp) : null,
    personal: o.audience === 'PERSONAL',
    targeted: !!o.target_segments,
    terms: o.terms,
    attachment: attachmentView(o),
  };
}

export function offerConditions(o) {
  const parts = [];
  if (o.min_spend_paise) parts.push(`Min. bill ₹${(o.min_spend_paise / 100).toLocaleString('en-IN')}`);
  if (o.category) parts.push(`Category: ${o.category}`);
  if (o.product) parts.push(o.type === 'FREE_PRODUCT' ? `Free: ${o.product}` : `Product: ${o.product}`);
  if (o.type === 'BONUS_POINTS') parts.push(`+${(o.bonus_cp / 100).toFixed(2)} bonus points, credited automatically`);
  if (o.type === 'MULTIPLIER') parts.push(`${o.multiplier}× points, credited automatically`);
  if (o.points_cost_cp) parts.push(`Uses ${(o.points_cost_cp / 100).toFixed(2)} points`);
  return parts.join(' · ');
}

/** Returns the offer if the customer can redeem it now, else throws. */
export function assertOfferRedeemable(customer, offerId, branchId, businessId = null) {
  const o = get('SELECT * FROM offers WHERE id = ?', offerId);
  if (!o) throw bad('Offer not found');
  if (!OFFER_TYPES[o.type]?.redeemable) throw bad('This offer is applied automatically on purchase and cannot be redeemed at the counter');
  if (businessId && o.business_id !== Number(businessId)) {
    const at = get('SELECT name FROM businesses WHERE id = ?', o.business_id)?.name;
    throw bad(`This reward can only be used at ${at || 'another business'}`);
  }
  const { everyone, forYou } = offersForCustomer(customer, { branchId });
  if (![...everyone, ...forYou].some((x) => x.id === o.id)) throw bad('Offer is not available for this customer (expired, used, or not valid at this branch)');
  return o;
}

/**
 * Points-engine hook used by the Excel import: extra points from bonus and
 * multiplier promotions for one bill. Multipliers don't stack (best one wins);
 * every qualifying bonus offer applies.
 */
export function autoOfferPoints({ customer, branchId, billDate, netPaise, items, baseCp }) {
  const rows = all(
    `SELECT o.*, a.uses_allowed FROM offers o
       LEFT JOIN offer_assignments a ON a.offer_id = o.id AND a.customer_id = ?
      WHERE o.active = 1 AND o.type IN ('BONUS_POINTS','MULTIPLIER')
        AND o.valid_from <= ? AND o.valid_to >= ?
        AND (o.audience = 'GLOBAL' OR (a.id IS NOT NULL AND (a.expires_on IS NULL OR a.expires_on >= ?)))`,
    customer.id, billDate, billDate, billDate,
  );
  const awards = [];
  let bestMult = null;
  const segs = customerSegmentSet(customer.id);
  for (const o of rows) {
    if (!branchOk(o, branchId) || netPaise < o.min_spend_paise || !targetOk(o, segs)) continue;
    if (usesOf(o.id, customer.id) >= (o.uses_allowed ?? o.max_uses_per_customer)) continue;
    if (o.type === 'BONUS_POINTS') awards.push({ offer: o, cp: o.bonus_cp });
    else {
      let eligiblePaise = netPaise;
      if (o.category || o.product) {
        const match = (it) =>
          (o.category && (it.category || '').toLowerCase() === o.category.toLowerCase()) ||
          (o.product && ((it.product_name || '').toLowerCase().includes(o.product.toLowerCase()) || (it.product_code || '').toLowerCase() === o.product.toLowerCase()));
        eligiblePaise = items.filter(match).reduce((s, it) => s + (it.amount_paise || 0), 0);
      }
      const fullCp = baseCp && netPaise ? Math.floor((baseCp * Math.min(eligiblePaise, netPaise)) / netPaise) : 0;
      const extra = Math.floor(fullCp * (o.multiplier - 1));
      if (extra > 0 && (!bestMult || extra > bestMult.cp)) bestMult = { offer: o, cp: extra };
    }
  }
  if (bestMult) awards.push(bestMult);
  return awards;
}
