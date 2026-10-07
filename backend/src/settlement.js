import { all, get, run, tx } from './db.js';
import { audit } from './audit.js';
import { rewardFunding } from './offers.js';
import { HttpError, bad, fmtPoints, isDate, nowIso, toPaise } from './util.js';

/**
 * Cross-business settlement.
 *
 * The program owner (Vasantham) runs a loyalty fund. When a customer's reward is used at a
 * business, that business gave a discount / product, so the fund owes it the funded amount
 * (PAYABLE). When a partner funds a reward that is used at a different business, the fund
 * pays the redeeming business in full and the funding partner owes the fund its share
 * (RECEIVABLE). Every business, the owner included, gets its own lines: accounting stays
 * separate even though the businesses share an owner today.
 *
 * Transactions are append-only. A reversal adds negative rows, so a settled period is
 * never rewritten; the correction lands in the next settlement.
 */
const IST = "'+330 minutes'";
const SETTLEABLE = "('BILLED','RECONCILED','REVERSED')"; // billing confirmed (or cancelled out)

function add(businessId, redemptionId, direction, kind, amount, note) {
  if (!amount) return;
  run(
    'INSERT INTO settlement_transactions(business_id, redemption_id, direction, kind, amount_paise, note, created_at) VALUES (?,?,?,?,?,?,?)',
    businessId, redemptionId, direction, kind, amount, note, nowIso(),
  );
}

/** Called inside the approval transaction. Returns the funding split to store on the redemption. */
export function recordRedemption(r, offer, business) {
  if (r.kind === 'POINTS') {
    add(business.id, r.id, 'PAYABLE', 'POINTS', r.value_paise, `${fmtPoints(r.cp)} points redeemed`);
    return { reward_cost_paise: 0, program_funded_paise: r.value_paise, partner_funded_paise: 0 };
  }
  const f = rewardFunding(offer);
  add(business.id, r.id, 'PAYABLE', 'REWARD', f.program, `Reward "${offer.title}" (loyalty fund)`);
  if (f.partner && f.funderId && f.funderId !== business.id) {
    const funder = get('SELECT name FROM businesses WHERE id = ?', f.funderId)?.name;
    add(business.id, r.id, 'PAYABLE', 'REWARD', f.partner, `Reward "${offer.title}" (funded by ${funder})`);
    add(f.funderId, r.id, 'RECEIVABLE', 'REWARD', f.partner, `Share of reward "${offer.title}" used at ${business.name}`);
  }
  // funder === redeeming business: it absorbs its own share, nothing moves
  return { reward_cost_paise: f.cost, program_funded_paise: f.program, partner_funded_paise: f.partner };
}

/** Called inside the reversal transaction: cancels whatever is still outstanding for this redemption. */
export function recordReversal(redemptionId, reason) {
  const rows = all(
    'SELECT business_id, direction, SUM(amount_paise) net FROM settlement_transactions WHERE redemption_id = ? GROUP BY business_id, direction',
    redemptionId,
  );
  for (const x of rows) add(x.business_id, redemptionId, x.direction, 'REVERSAL', -x.net, `Reversed: ${reason}`);
}

function period(from, to) {
  if (!isDate(from) || !isDate(to) || to < from) throw bad('Choose a valid period (from / to dates)');
  return [from, to];
}

/** Business-wise settlement report for a period (IST dates, inclusive). */
export function settlementReport({ from, to, businessId = null }) {
  period(from, to);
  const biz = all(`SELECT id, code, name, is_program_owner, settlement_cycle FROM businesses WHERE (? IS NULL OR id = ?) ORDER BY is_program_owner DESC, sort_order, name`, businessId, businessId);
  const rows = biz.map((b) => {
    const act = get(
      `SELECT COUNT(*) redemptions,
              COALESCE(SUM(cp),0) points_cp,
              COALESCE(SUM(CASE WHEN kind = 'POINTS' THEN value_paise END),0) points_value_paise,
              COALESCE(SUM(CASE WHEN kind = 'OFFER' THEN 1 END),0) rewards,
              COALESCE(SUM(CASE WHEN kind = 'OFFER' THEN value_paise END),0) reward_value_paise,
              COALESCE(SUM(reward_cost_paise),0) reward_cost_paise,
              COALESCE(SUM(program_funded_paise),0) program_funded_paise,
              COALESCE(SUM(partner_funded_paise),0) partner_funded_paise,
              COALESCE(SUM(bill_paise),0) bill_paise
         FROM redemptions
        WHERE business_id = ? AND approved_at IS NOT NULL AND status <> 'REVERSED'
          AND date(approved_at, ${IST}) BETWEEN ? AND ?`,
      b.id, from, to,
    );
    const m = get(
      `SELECT COALESCE(SUM(CASE WHEN t.direction = 'PAYABLE' THEN t.amount_paise END),0) payable,
              COALESCE(SUM(CASE WHEN t.direction = 'RECEIVABLE' THEN t.amount_paise END),0) receivable,
              COALESCE(SUM(CASE WHEN s.status = 'SETTLED' THEN (CASE t.direction WHEN 'PAYABLE' THEN 1 ELSE -1 END) * t.amount_paise END),0) settled,
              COALESCE(SUM(CASE WHEN s.status = 'OPEN' THEN (CASE t.direction WHEN 'PAYABLE' THEN 1 ELSE -1 END) * t.amount_paise END),0) in_open,
              COALESCE(SUM(CASE WHEN t.settlement_id IS NULL AND r.status IN ${SETTLEABLE} THEN (CASE t.direction WHEN 'PAYABLE' THEN 1 ELSE -1 END) * t.amount_paise END),0) ready,
              COALESCE(SUM(CASE WHEN t.settlement_id IS NULL AND r.status NOT IN ${SETTLEABLE} THEN (CASE t.direction WHEN 'PAYABLE' THEN 1 ELSE -1 END) * t.amount_paise END),0) awaiting_billing
         FROM settlement_transactions t
         JOIN redemptions r ON r.id = t.redemption_id
         LEFT JOIN settlements s ON s.id = t.settlement_id
        WHERE t.business_id = ? AND date(t.created_at, ${IST}) BETWEEN ? AND ?`,
      b.id, from, to,
    );
    const net = m.payable - m.receivable;
    return {
      business_id: b.id, code: b.code, name: b.name, is_program_owner: !!b.is_program_owner, settlement_cycle: b.settlement_cycle,
      ...act,
      payable_paise: m.payable,
      receivable_paise: m.receivable,
      net_paise: net, // + = loyalty fund pays the business, - = business pays the fund
      settled_paise: m.settled,
      in_open_settlement_paise: m.in_open,
      ready_to_settle_paise: m.ready,
      awaiting_billing_paise: m.awaiting_billing,
      pending_paise: net - m.settled,
    };
  });
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const totals = Object.fromEntries(['redemptions', 'points_cp', 'points_value_paise', 'rewards', 'reward_value_paise', 'reward_cost_paise', 'program_funded_paise',
    'partner_funded_paise', 'payable_paise', 'receivable_paise', 'net_paise', 'settled_paise', 'pending_paise', 'ready_to_settle_paise', 'awaiting_billing_paise'].map((k) => [k, sum(k)]));
  return { from, to, rows, totals };
}

/** Batch a business's billing-confirmed, unsettled transactions for a period into a settlement. */
export function createSettlement({ businessId, from, to, note }, staff, ip) {
  period(from, to);
  return tx(() => {
    const b = get('SELECT * FROM businesses WHERE id = ?', businessId);
    if (!b) throw new HttpError(404, 'Business not found');
    const txns = all(
      `SELECT t.* FROM settlement_transactions t JOIN redemptions r ON r.id = t.redemption_id
        WHERE t.business_id = ? AND t.settlement_id IS NULL AND r.status IN ${SETTLEABLE}
          AND date(t.created_at, ${IST}) BETWEEN ? AND ?`,
      b.id, from, to,
    );
    if (!txns.length) throw bad(`Nothing ready to settle for ${b.name} in this period (redemptions still awaiting billing are left out)`);
    const payable = txns.filter((t) => t.direction === 'PAYABLE').reduce((s, t) => s + t.amount_paise, 0);
    const receivable = txns.filter((t) => t.direction === 'RECEIVABLE').reduce((s, t) => s + t.amount_paise, 0);
    const id = Number(run(
      'INSERT INTO settlements(business_id, period_from, period_to, payable_paise, receivable_paise, txn_count, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      b.id, from, to, payable, receivable, txns.length, String(note || '').trim() || null, staff.id, nowIso(),
    ).lastInsertRowid);
    for (const t of txns) run('UPDATE settlement_transactions SET settlement_id = ? WHERE id = ?', id, t.id);
    audit({ type: staff.role, id: staff.id, name: staff.name }, 'SETTLEMENT_CREATED', 'settlement', id, { business: b.code, from, to, payable, receivable, txns: txns.length }, ip);
    return settlementDetail(id);
  });
}

export function markSettled(id, { amount, reference, note }, staff, ip) {
  return tx(() => {
    const s = get('SELECT * FROM settlements WHERE id = ?', id);
    if (!s) throw new HttpError(404, 'Settlement not found');
    if (s.status !== 'OPEN') throw bad(`Settlement is already ${s.status.toLowerCase()}`);
    const net = s.payable_paise - s.receivable_paise;
    const paid = amount === undefined || amount === '' || amount === null ? Math.abs(net) : toPaise(amount);
    if (paid == null || paid < 0) throw bad('Enter the amount settled');
    const ref = String(reference || '').trim();
    if (!ref) throw bad('Enter the payment / journal reference');
    run("UPDATE settlements SET status = 'SETTLED', settled_paise = ?, settled_at = ?, settled_by = ?, reference = ?, note = COALESCE(?, note) WHERE id = ?",
      paid, nowIso(), staff.id, ref.slice(0, 120), String(note || '').trim() || null, id);
    audit({ type: staff.role, id: staff.id, name: staff.name }, 'SETTLEMENT_SETTLED', 'settlement', id, { amount: paid, net, reference: ref }, ip);
    return settlementDetail(id);
  });
}

/** Undo an OPEN settlement (e.g. created for the wrong period); its transactions become unsettled again. */
export function voidSettlement(id, reason, staff, ip) {
  reason = String(reason || '').trim();
  if (!reason) throw bad('A reason is required');
  return tx(() => {
    const s = get('SELECT * FROM settlements WHERE id = ?', id);
    if (!s) throw new HttpError(404, 'Settlement not found');
    if (s.status !== 'OPEN') throw bad('Only an open (unpaid) settlement can be voided');
    run('UPDATE settlement_transactions SET settlement_id = NULL WHERE settlement_id = ?', id);
    run("UPDATE settlements SET status = 'VOID', note = ? WHERE id = ?", `Voided: ${reason}`, id);
    audit({ type: staff.role, id: staff.id, name: staff.name }, 'SETTLEMENT_VOIDED', 'settlement', id, { reason }, ip);
    return settlementDetail(id);
  });
}

export function listSettlements({ businessId = null } = {}) {
  return all(
    `SELECT s.*, b.name business_name, b.code business_code, c.name created_by_name, p.name settled_by_name
       FROM settlements s JOIN businesses b ON b.id = s.business_id
       LEFT JOIN staff c ON c.id = s.created_by LEFT JOIN staff p ON p.id = s.settled_by
      WHERE (? IS NULL OR s.business_id = ?) ORDER BY s.id DESC LIMIT 300`,
    businessId, businessId,
  ).map((s) => ({ ...s, net_paise: s.payable_paise - s.receivable_paise }));
}

export function settlementDetail(id) {
  const s = listSettlements().find((x) => x.id === Number(id)) || null;
  if (!s) throw new HttpError(404, 'Settlement not found');
  return {
    ...s,
    transactions: all(
      `SELECT t.*, r.kind, r.status redemption_status, r.cp, r.value_paise, r.approved_at, r.bill_paise, br.name branch, c.mobile, o.title offer_title
         FROM settlement_transactions t JOIN redemptions r ON r.id = t.redemption_id
         LEFT JOIN branches br ON br.id = r.branch_id JOIN customers c ON c.id = r.customer_id LEFT JOIN offers o ON o.id = r.offer_id
        WHERE t.settlement_id = ? ORDER BY t.id`,
      id,
    ),
  };
}

/** Unsettled transactions for one business (drill-down from the report). */
export function openTransactions(businessId, { from, to }) {
  period(from, to);
  return all(
    `SELECT t.*, r.kind, r.status redemption_status, r.cp, r.value_paise, r.approved_at, r.bill_paise, br.name branch, c.mobile, o.title offer_title
       FROM settlement_transactions t JOIN redemptions r ON r.id = t.redemption_id
       LEFT JOIN branches br ON br.id = r.branch_id JOIN customers c ON c.id = r.customer_id LEFT JOIN offers o ON o.id = r.offer_id
      WHERE t.business_id = ? AND t.settlement_id IS NULL AND date(t.created_at, ${IST}) BETWEEN ? AND ?
      ORDER BY t.id DESC LIMIT 1000`,
    businessId, from, to,
  );
}
