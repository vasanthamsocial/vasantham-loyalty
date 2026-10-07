import { get, run } from './db.js';
import { nowIso } from './util.js';

/**
 * Ledger entry types:
 *  EARN             purchase points (base rate)
 *  BONUS            promotion points (bonus / multiplier offers)
 *  REDEEM           points redeemed (negative)
 *  REDEEM_REVERSAL  redemption cancelled after approval, points restored
 *  RETURN_REVERSAL  purchase returned / bill cancelled, earned points reversed
 *  ADJUST           manual adjustment by admin (+/-)
 */
export const LEDGER_TYPES = ['EARN', 'BONUS', 'REDEEM', 'REDEEM_REVERSAL', 'RETURN_REVERSAL', 'ADJUST'];

/** Must be called inside a transaction. Returns the new balance. */
export function postLedger({ customerId, type, cp, branchId = null, purchaseId = null, redemptionId = null, offerId = null, note = null, actor }) {
  if (!Number.isInteger(cp) || cp === 0) return null;
  const c = get('SELECT balance_cp FROM customers WHERE id = ?', customerId);
  const bal = c.balance_cp + cp;
  run('UPDATE customers SET balance_cp = ? WHERE id = ?', bal, customerId);
  run(
    `INSERT INTO points_ledger(customer_id, type, cp, balance_after_cp, branch_id, purchase_id, redemption_id, offer_id, note, actor_type, actor_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    customerId, type, cp, bal, branchId, purchaseId, redemptionId, offerId, note,
    actor?.type || 'SYSTEM', actor?.id ?? null, nowIso(),
  );
  return bal;
}

export function pointsSummary(customerId) {
  return get(
    `SELECT
       COALESCE(SUM(CASE WHEN type IN ('EARN','BONUS') THEN cp END),0)
         + COALESCE(SUM(CASE WHEN type = 'ADJUST' AND cp > 0 THEN cp END),0) AS earned_cp,
       -COALESCE(SUM(CASE WHEN type IN ('REDEEM','REDEEM_REVERSAL') THEN cp END),0) AS redeemed_cp,
       -COALESCE(SUM(CASE WHEN type = 'RETURN_REVERSAL' THEN cp END),0)
         - COALESCE(SUM(CASE WHEN type = 'ADJUST' AND cp < 0 THEN cp END),0) AS reversed_cp
     FROM points_ledger WHERE customer_id = ?`,
    customerId,
  );
}
