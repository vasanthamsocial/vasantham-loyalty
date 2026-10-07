import { all, get, setting } from './db.js';
import { cleanPhone, cleanText } from './contact.js';
import { logoUrl } from './media.js';
import { bad, cpToPaise, fmtPoints, fmtRupees, parsePointsInput, toPaise } from './util.js';

/**
 * Businesses in the loyalty ecosystem. Nothing here is specific to the four launch
 * businesses: each one is a row with its own earn / redeem permissions and rules.
 * The program owner (Vasantham) runs the loyalty fund that settles with the others.
 */
export const LIMIT_TYPES = {
  NONE: 'No limit (up to the points balance)',
  PERCENT: 'Percentage of the bill',
  AMOUNT: 'Maximum ₹ per redemption',
  PERCENT_AND_AMOUNT: 'Percentage of the bill, up to a maximum ₹',
};
export const SETTLEMENT_CYCLES = ['WEEKLY', 'MONTHLY', 'CUSTOM'];
export const BILLING_SOURCES = {
  EXCEL: 'Daily Excel upload (bills matched automatically)',
  MANAGER: 'Manager confirms the bill in the Manager Panel',
};

export const ownerBusiness = () => get('SELECT * FROM businesses WHERE is_program_owner = 1 ORDER BY id LIMIT 1');
export const getBusiness = (id) => get('SELECT * FROM businesses WHERE id = ?', id);
export const businessOfBranch = (branchId) =>
  (branchId && get('SELECT bz.* FROM branches b JOIN businesses bz ON bz.id = b.business_id WHERE b.id = ?', branchId)) || ownerBusiness();

export function ruleOf(businessId) {
  return get('SELECT * FROM business_redemption_rules WHERE business_id = ?', businessId)
    || { business_id: businessId, limit_type: 'NONE', max_percent: null, max_value_paise: null, min_bill_paise: 0, min_points_cp: 0, branch_ids: null };
}

const flag = (v, dflt) => (v === undefined ? dflt : v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

/** Validate admin input for a business profile. `cur` is the existing row on update. */
export function normaliseBusiness(b = {}, cur = null) {
  const code = cur ? cur.code : String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,12}$/.test(code)) throw bad('Business code: 2–12 letters / digits');
  const name = String(b.name ?? cur?.name ?? '').trim().slice(0, 80);
  if (!name) throw bad('Business name is required');
  const email = cleanText(b.contact_email ?? cur?.contact_email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Contact email is not valid');
  const billing = String(b.billing_source ?? cur?.billing_source ?? 'MANAGER').toUpperCase();
  if (!BILLING_SOURCES[billing]) throw bad('Choose how bills are confirmed');
  const cycle = String(b.settlement_cycle ?? cur?.settlement_cycle ?? 'MONTHLY').toUpperCase();
  if (!SETTLEMENT_CYCLES.includes(cycle)) throw bad('Settlement cycle must be weekly, monthly or custom');
  const pick = (k, max) => cleanText(b[k] === undefined ? cur?.[k] : b[k], max);
  const out = {
    code,
    name,
    category: pick('category', 60),
    tagline: pick('tagline', 120),
    active: flag(b.active, cur ? cur.active : 1),
    can_earn: flag(b.can_earn, cur ? cur.can_earn : 0),
    can_redeem: flag(b.can_redeem, cur ? cur.can_redeem : 1),
    billing_source: billing,
    offer_participation: flag(b.offer_participation, cur ? cur.offer_participation : 1),
    settlement_cycle: cycle,
    settlement_details: pick('settlement_details', 300),
    contact_person: pick('contact_person', 80),
    contact_phone: b.contact_phone === undefined ? cur?.contact_phone ?? null : cleanPhone(b.contact_phone, 'Contact phone'),
    contact_email: email,
    address: pick('address', 300),
    terms: pick('terms', 2000),
    notes: pick('notes', 2000),
    sort_order: Number.isFinite(Number(b.sort_order)) && b.sort_order !== '' && b.sort_order != null ? Math.trunc(Number(b.sort_order)) : cur?.sort_order ?? 100,
  };
  if (cur?.is_program_owner && !out.active) throw bad('The program owner business cannot be deactivated');
  return out;
}

/** Validate a redemption policy. */
export function normaliseRule(b = {}, businessId) {
  const limit = String(b.limit_type || 'NONE').toUpperCase();
  if (!LIMIT_TYPES[limit]) throw bad('Choose a redemption limit type');
  const pct = limit.includes('PERCENT') ? Number(b.max_percent) : null;
  if (limit.includes('PERCENT') && !(pct > 0 && pct <= 100)) throw bad('Maximum redemption % must be between 1 and 100');
  const maxVal = limit === 'AMOUNT' || limit === 'PERCENT_AND_AMOUNT' ? toPaise(b.max_value) : null;
  if ((limit === 'AMOUNT' || limit === 'PERCENT_AND_AMOUNT') && !(maxVal > 0)) throw bad('Maximum redemption value (₹) is required');
  const minBill = toPaise(b.min_bill) ?? 0;
  if (minBill < 0) throw bad('Minimum bill cannot be negative');
  const minPts = b.min_points === '' || b.min_points == null ? 0 : parsePointsInput(b.min_points);
  let branchIds = null;
  if (Array.isArray(b.branch_ids) && b.branch_ids.length) {
    const ids = b.branch_ids.map(Number);
    const own = new Set(all('SELECT id FROM branches WHERE business_id = ?', businessId).map((r) => r.id));
    if (ids.some((id) => !own.has(id))) throw bad('Eligible outlets must belong to this business');
    branchIds = ids.join(',');
  }
  return { limit_type: limit, max_percent: pct, max_value_paise: maxVal, min_bill_paise: minBill, min_points_cp: minPts, branch_ids: branchIds };
}

/** Plain-language rule lines for the marketplace, manager panel and receipt. */
export function ruleLines(rule) {
  const out = [];
  if (rule.limit_type === 'PERCENT') out.push(`Points can pay up to ${rule.max_percent}% of the bill`);
  if (rule.limit_type === 'AMOUNT') out.push(`Up to ${fmtRupees(rule.max_value_paise)} per redemption`);
  if (rule.limit_type === 'PERCENT_AND_AMOUNT') out.push(`Points can pay up to ${rule.max_percent}% of the bill, maximum ${fmtRupees(rule.max_value_paise)}`);
  if (rule.limit_type === 'NONE') out.push('Use any amount of your points');
  if (rule.min_bill_paise) out.push(`Minimum bill ${fmtRupees(rule.min_bill_paise)}`);
  if (rule.min_points_cp) out.push(`Minimum ${fmtPoints(rule.min_points_cp)} points`);
  if (rule.branch_ids) {
    const names = all(`SELECT name FROM branches WHERE id IN (${rule.branch_ids.split(',').map(Number).join(',')}) ORDER BY name`).map((r) => r.name);
    if (names.length) out.push(`At: ${names.join(', ')}`);
  }
  return out;
}

export const needsBill = (rule, offer = null) => rule.limit_type.includes('PERCENT') || rule.min_bill_paise > 0 || (offer?.min_spend_paise ?? 0) > 0;
export const minBillFor = (rule, offer = null) => Math.max(rule.min_bill_paise || 0, offer?.min_spend_paise || 0);

/**
 * The most points (₹) a customer may redeem at a business right now.
 * Without a bill amount the % limit can't be applied yet (it is checked at approval).
 */
export function pointsCap({ rule, balanceCp, billPaise = null }) {
  const caps = [{ paise: cpToPaise(Math.max(0, balanceCp)), by: 'BALANCE' }];
  if (rule.max_value_paise && rule.limit_type !== 'PERCENT' && rule.limit_type !== 'NONE') caps.push({ paise: rule.max_value_paise, by: 'MAX_VALUE' });
  if (rule.limit_type.includes('PERCENT') && billPaise != null) caps.push({ paise: Math.floor((billPaise * rule.max_percent) / 100), by: 'PERCENT' });
  const globalMax = Math.round(setting('max_redeem_points') * 100);
  if (globalMax > 0) caps.push({ paise: cpToPaise(globalMax), by: 'GLOBAL_MAX' });
  const min = caps.reduce((a, c) => (c.paise < a.paise ? c : a));
  const maxCp = Math.floor(min.paise / cpToPaise(1));
  return { maxCp, maxPaise: cpToPaise(maxCp), limitedBy: min.by };
}

export function branchEligible(rule, branchId) {
  return !rule.branch_ids || rule.branch_ids.split(',').map(Number).includes(Number(branchId));
}

export function assertCanRedeemAt(business) {
  if (!business || !business.active) throw bad('This business is not active in Vasantham Rewards');
  if (!business.can_redeem) throw bad(`${business.name} does not accept loyalty redemptions`);
}

/**
 * Server-side rule check for one redemption. Called when the request is created
 * (without a bill) and again, strictly, when a manager approves it.
 */
export function checkRedemptionRules({ business, rule, branchId = null, kind, cp, offer = null, billPaise = null, balanceCp, atApproval }) {
  assertCanRedeemAt(business);
  if (branchId && !branchEligible(rule, branchId)) throw bad(`This outlet is not eligible for ${business.name} redemptions`);
  if (atApproval && needsBill(rule, offer) && billPaise == null) throw bad('Enter the customer\'s bill amount to check the redemption rules', { needs_bill: true });
  if (billPaise != null) {
    if (!(billPaise > 0)) throw bad('Enter a valid bill amount');
    const minBill = minBillFor(rule, offer);
    if (billPaise < minBill) throw bad(`Minimum bill for this redemption is ${fmtRupees(minBill)}`);
  }
  if (cp > balanceCp) throw bad(`Insufficient points. Available: ${fmtPoints(Math.max(0, balanceCp))}`);
  if (kind === 'POINTS') {
    if (rule.min_points_cp && cp < rule.min_points_cp) throw bad(`Minimum redemption at ${business.name} is ${fmtPoints(rule.min_points_cp)} points`);
    const cap = pointsCap({ rule, balanceCp, billPaise });
    if (cp > cap.maxCp) {
      throw bad(
        `Maximum you can redeem at ${business.name}${cap.limitedBy === 'PERCENT' ? ' on this bill' : ''} is ${fmtRupees(cap.maxPaise)} (${fmtPoints(cap.maxCp)} points)`,
        { max_cp: cap.maxCp, max_paise: cap.maxPaise },
      );
    }
  }
}

export function businessView(b, { withRule = true } = {}) {
  const rule = withRule ? ruleOf(b.id) : null;
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    category: b.category,
    tagline: b.tagline,
    logo_url: logoUrl(b.logo_file),
    can_earn: !!b.can_earn,
    can_redeem: !!b.can_redeem,
    is_program_owner: !!b.is_program_owner,
    billing_source: b.billing_source,
    terms: b.terms,
    ...(rule ? { rule: { ...rule, lines: ruleLines(rule), needs_bill: needsBill(rule) } } : {}),
  };
}

export const activeRedeemBusinesses = () =>
  all('SELECT * FROM businesses WHERE active = 1 AND can_redeem = 1 ORDER BY is_program_owner DESC, sort_order, name');
