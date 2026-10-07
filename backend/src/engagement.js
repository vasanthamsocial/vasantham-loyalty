import { runAutomations } from './automations.js';
import { evaluateChallenges } from './challenges.js';
import { expireReferrals, qualifyReferrals } from './referrals.js';

/**
 * Engagement engine hooks. Called by the Excel import once segments are refreshed:
 * challenge progress and rewards, referral qualification, then reactivation automations.
 * `byCustomer` maps customerId → Set of bill dates in the upload.
 */
export function afterPurchases(byCustomer) {
  const ch = evaluateChallenges(byCustomer);
  const referrals = qualifyReferrals([...byCustomer.keys()]);
  const auto = runAutomations();
  return { challengeAwards: ch.awards, referralsRewarded: referrals, reactivationTargeted: auto.reduce((s, a) => s + a.targeted, 0) };
}

/** Nightly housekeeping (after segments are recomputed for the new day). */
export function dailyEngagement() {
  expireReferrals();
  runAutomations();
}
