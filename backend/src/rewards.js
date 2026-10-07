import { get, run } from './db.js';
import { postLedger } from './points.js';
import { notify } from './audit.js';
import { OFFER_TYPES } from './offers.js';
import { addDays, bad, fmtPoints, istDate, nowIso, parsePointsInput } from './util.js';

/**
 * Granting rewards to one customer: bonus points straight into the ledger, or unlocking a
 * personalised offer / coupon (at any business). Used by challenges, referrals and
 * reactivation automations. Every grant is one extra use of the offer for that customer.
 */

/** Admin picked an offer as a reward: it must be a personalised (unlock-per-customer) offer. */
export function assertGrantableOffer(offerId, label = 'Reward') {
  const o = offerId ? get('SELECT * FROM offers WHERE id = ?', Number(offerId)) : null;
  if (!o) throw bad(`${label}: choose the offer to unlock`);
  if (o.audience !== 'PERSONAL') throw bad(`${label}: "${o.title}" is an offer for everyone. Choose a personalised offer, which is unlocked per customer.`);
  if (!o.active) throw bad(`${label}: "${o.title}" is inactive`);
  if (!OFFER_TYPES[o.type]) throw bad(`${label}: unknown offer type`);
  return o;
}

/** Parse a reward definition from admin input: { type, points, offer_id, valid_days }. */
export function normaliseReward(b = {}, label = 'Reward') {
  const type = String(b.type || '').toUpperCase();
  if (type === 'POINTS') {
    const cp = parsePointsInput(b.points);
    if (!cp) throw bad(`${label}: enter the bonus points`);
    return { type, cp, offer_id: null };
  }
  if (type === 'OFFER') return { type, cp: 0, offer_id: assertGrantableOffer(b.offer_id, label).id };
  throw bad(`${label}: choose bonus points or an offer / coupon`);
}

export function grantOffer(customerId, offer, { validDays = 30, source, campaignId = null } = {}) {
  const today = istDate();
  if (!offer.active || offer.valid_to < today) return null;
  let exp = addDays(today, Math.max(1, validDays) - 1);
  if (exp > offer.valid_to) exp = offer.valid_to;
  const a = get('SELECT * FROM offer_assignments WHERE offer_id = ? AND customer_id = ?', offer.id, customerId);
  if (a) {
    run(
      `UPDATE offer_assignments SET uses_allowed = COALESCE(uses_allowed, ?) + 1, source = ?,
         expires_on = CASE WHEN expires_on IS NULL THEN NULL WHEN expires_on < ? THEN ? ELSE expires_on END WHERE id = ?`,
      offer.max_uses_per_customer, source, exp, exp, a.id,
    );
  } else {
    run('INSERT INTO offer_assignments(offer_id, customer_id, campaign_id, assigned_at, expires_on, uses_allowed, source) VALUES (?,?,?,?,?,1,?)',
      offer.id, customerId, campaignId, nowIso(), exp, source);
  }
  return exp;
}

/**
 * Give one reward. Must run inside a transaction. Returns a short description, or null
 * if the reward could not be given (e.g. the offer has expired).
 */
export function grantReward(customerId, reward, { source, title, note, validDays = 30 }) {
  if (reward.type === 'POINTS') {
    postLedger({ customerId, type: 'BONUS', cp: reward.cp, note, actor: { type: 'SYSTEM' } });
    notify(customerId, 'REWARD_UNLOCKED', title, `${note}: +${fmtPoints(reward.cp)} points added to your balance.`);
    return `${fmtPoints(reward.cp)} bonus points`;
  }
  const o = get('SELECT o.*, b.name business_name FROM offers o JOIN businesses b ON b.id = o.business_id WHERE o.id = ?', reward.offer_id);
  if (!o) return null;
  const exp = grantOffer(customerId, o, { validDays, source });
  if (!exp) return null;
  notify(customerId, 'REWARD_UNLOCKED', title, `${note}: you unlocked "${o.title}" at ${o.business_name}, valid till ${exp}. See Rewards → My coupons.`, o.id);
  return `"${o.title}" (${o.business_name})`;
}

/** For display: what a reward is. */
export function rewardLabel(r) {
  if (r.type === 'POINTS' || r.reward_type === 'POINTS') return `${fmtPoints(r.cp ?? r.reward_cp)} bonus points`;
  const id = r.offer_id ?? r.reward_offer_id;
  const o = id ? get('SELECT o.title, b.name business_name FROM offers o JOIN businesses b ON b.id = o.business_id WHERE o.id = ?', id) : null;
  return o ? `${o.title} (${o.business_name})` : 'Reward';
}
