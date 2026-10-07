import { all, db, get, run, setting, tx } from './db.js';
import { campaignReport } from './analytics.js';
import { addDays, bad, cpToPaise, isDate, istDate, nowIso } from './util.js';

/**
 * Ecosystem growth analytics.
 *
 * "Revenue associated with redemption / reward value used" is an operational efficiency
 * metric: the bills on which a reward was used, divided by the value of the rewards. It is
 * NOT incremental revenue (the customer might have bought anyway).
 */
const DONE = "('APPROVED','SUBMITTED','BILLED','RECONCILED')";
const IST = "'+330 minutes'";

/* ---------- customer_business_activity ---------- */

/** Rebuild each customer's relationship with each business from purchases and completed redemptions. */
export function rebuildActivity() {
  const now = nowIso();
  tx(() => {
    db.exec('DELETE FROM customer_business_activity');
    db.prepare(
      `INSERT INTO customer_business_activity(customer_id, business_id, first_activity_date, last_activity_date, first_via, purchases, spend_paise,
         redemptions, redemption_value_paise, first_redemption_date, last_redemption_date, updated_at)
       SELECT customer_id, business_id, MIN(d), MAX(d), substr(MIN(d || '|' || via), 12), SUM(pur), SUM(spend), SUM(red), SUM(rv), MIN(rd), MAX(rd), ?
         FROM (
           SELECT p.customer_id, b.business_id, p.bill_date d, 'PURCHASE' via,
                  CASE WHEN p.bill_type = 'SALE' THEN 1 ELSE 0 END pur,
                  CASE WHEN p.bill_type = 'SALE' THEN p.net_paise ELSE -p.net_paise END spend, 0 red, 0 rv, NULL rd
             FROM purchases p JOIN branches b ON b.id = p.branch_id WHERE p.customer_id IS NOT NULL
           UNION ALL
           SELECT r.customer_id, r.business_id, date(r.approved_at, ${IST}), 'REDEMPTION', 0, 0, 1, r.value_paise, date(r.approved_at, ${IST})
             FROM redemptions r WHERE r.status IN ${DONE} AND r.business_id IS NOT NULL
         ) GROUP BY customer_id, business_id`,
    ).run(now);
  });
  run("INSERT INTO settings(key, value) VALUES ('activity_built_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(Date.now()));
}

/** Rebuilt after uploads; also refreshed here if older than a minute (redemptions happen all day). */
function ensureActivity() {
  const at = Number(get("SELECT value FROM settings WHERE key = 'activity_built_at'")?.value || 0);
  if (Date.now() - at > 60e3) rebuildActivity();
}

/* ---------- helpers ---------- */

const ratio = (a, b) => (b ? a / b : null);

/** Money and counts for completed redemptions approved in [from, to], per business. */
function redemptionStats(from, to, businessId) {
  const rows = all(
    `SELECT bz.id business_id, bz.name, bz.code, bz.is_program_owner,
            COUNT(r.id) redemptions,
            COUNT(DISTINCT r.customer_id) customers,
            COALESCE(SUM(r.cp), 0) points_cp,
            COALESCE(SUM(CASE WHEN r.kind = 'POINTS' THEN r.value_paise END), 0) points_value_paise,
            COALESCE(SUM(CASE WHEN r.kind = 'OFFER' THEN r.value_paise END), 0) reward_face_paise,
            COALESCE(SUM(CASE WHEN r.kind = 'OFFER' THEN 1 END), 0) rewards,
            COALESCE(SUM(CASE WHEN r.kind = 'POINTS' THEN r.value_paise ELSE r.reward_cost_paise END), 0) reward_cost_paise,
            COALESCE(SUM(r.partner_funded_paise), 0) partner_funded_paise
       FROM businesses bz
       LEFT JOIN redemptions r ON r.business_id = bz.id AND r.status IN ${DONE} AND date(r.approved_at, ${IST}) BETWEEN ? AND ?
      WHERE (? IS NULL OR bz.id = ?)
      GROUP BY bz.id ORDER BY bz.is_program_owner DESC, bz.sort_order, bz.name`,
    from, to, businessId, businessId,
  );
  // Bills a reward was used on. A bill with two redemptions counts once. Vasantham bills come from
  // the Excel upload (net value); partner bills from the amount the outlet manager confirmed.
  const bills = all(
    `SELECT business_id, COUNT(*) bills, COALESCE(SUM(bill), 0) revenue FROM (
        SELECT r.business_id, COALESCE('P' || r.purchase_id, 'R' || r.id) k, MAX(COALESCE(p.net_paise, r.bill_paise)) bill
          FROM redemptions r LEFT JOIN purchases p ON p.id = r.purchase_id
         WHERE r.status IN ${DONE} AND date(r.approved_at, ${IST}) BETWEEN ? AND ? AND (? IS NULL OR r.business_id = ?)
         GROUP BY r.business_id, k HAVING bill IS NOT NULL)
      GROUP BY business_id`,
    from, to, businessId, businessId,
  );
  const byBiz = Object.fromEntries(bills.map((b) => [b.business_id, b]));
  return rows.map((r) => {
    const b = byBiz[r.business_id] || { bills: 0, revenue: 0 };
    const valueUsed = r.points_value_paise + r.reward_face_paise;
    return {
      ...r,
      reward_value_paise: valueUsed,
      linked_bills: b.bills,
      linked_revenue_paise: b.revenue,
      avg_linked_bill_paise: b.bills ? Math.round(b.revenue / b.bills) : null,
      revenue_to_reward: b.bills ? ratio(b.revenue, valueUsed) : null, // no known bill yet → no ratio, not 0
    };
  });
}

function sumRows(rows, keys) {
  return Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + (r[k] || 0), 0)]));
}

/* ---------- dashboard ---------- */

export function growthDashboard({ from, to, businessId = null }) {
  if (!isDate(from) || !isDate(to) || to < from) throw bad('Choose a valid period');
  ensureActivity();
  const owner = get('SELECT * FROM businesses WHERE is_program_owner = 1');
  const scoped = !!businessId;
  const bizName = scoped ? get('SELECT name FROM businesses WHERE id = ?', businessId)?.name : null;

  /* redemptions, reward value and the key ratio */
  const perBusiness = redemptionStats(from, to, businessId);
  const tot = sumRows(perBusiness, ['redemptions', 'points_cp', 'points_value_paise', 'reward_face_paise', 'reward_value_paise', 'reward_cost_paise',
    'partner_funded_paise', 'linked_bills', 'linked_revenue_paise', 'rewards']);
  tot.customers = get(
    `SELECT COUNT(DISTINCT customer_id) n FROM redemptions WHERE status IN ${DONE} AND date(approved_at, ${IST}) BETWEEN ? AND ? AND (? IS NULL OR business_id = ?)`,
    from, to, businessId, businessId,
  ).n;
  tot.revenue_to_reward = ratio(tot.linked_revenue_paise, tot.reward_value_paise);
  tot.avg_linked_bill_paise = tot.linked_bills ? Math.round(tot.linked_revenue_paise / tot.linked_bills) : null;

  /* first-time customers generated for each business, and how they first came */
  const firstTime = all(
    `SELECT bz.id business_id, bz.name,
            COUNT(a.customer_id) first_time,
            SUM(CASE WHEN a.first_via = 'REDEMPTION' THEN 1 ELSE 0 END) via_redemption,
            SUM(CASE WHEN a.first_via = 'PURCHASE' THEN 1 ELSE 0 END) via_purchase
       FROM businesses bz LEFT JOIN customer_business_activity a ON a.business_id = bz.id AND a.first_activity_date BETWEEN ? AND ?
      WHERE (? IS NULL OR bz.id = ?) GROUP BY bz.id ORDER BY bz.is_program_owner DESC, bz.sort_order, bz.name`,
    from, to, businessId, businessId,
  );

  /* repeat after the first ecosystem redemption: first redemption (anywhere, or at this business) in the period,
     and any later purchase or redemption */
  const firstRed = scoped
    ? `SELECT customer_id, first_redemption_date f FROM customer_business_activity WHERE business_id = ${Number(businessId)} AND first_redemption_date IS NOT NULL`
    : 'SELECT customer_id, MIN(first_redemption_date) f FROM customer_business_activity WHERE first_redemption_date IS NOT NULL GROUP BY customer_id';
  const repeat = get(
    `SELECT COUNT(*) first_redeemers,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM purchases p JOIN branches b ON b.id = p.branch_id
                                   WHERE p.customer_id = x.customer_id AND p.bill_type = 'SALE' AND p.bill_date > x.f ${scoped ? `AND b.business_id = ${Number(businessId)}` : ''})
                       OR EXISTS (SELECT 1 FROM redemptions r WHERE r.customer_id = x.customer_id AND r.status IN ${DONE}
                                   AND date(r.approved_at, ${IST}) > x.f ${scoped ? `AND r.business_id = ${Number(businessId)}` : ''})
                     THEN 1 ELSE 0 END) repeated
       FROM (${firstRed}) x WHERE x.f BETWEEN ? AND ?`,
    from, to,
  );
  repeat.repeated ||= 0;
  repeat.repeat_rate = ratio(repeat.repeated, repeat.first_redeemers);

  /* cross-business movement: who redeems at partners, and where else they go */
  const movement = all(
    `SELECT bz.id business_id, bz.name,
            COUNT(DISTINCT r.customer_id) customers,
            COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM purchases p JOIN branches b ON b.id = p.branch_id
                   WHERE p.customer_id = r.customer_id AND p.bill_type = 'SALE' AND b.business_id = ? AND p.bill_date BETWEEN ? AND ?) THEN r.customer_id END) also_vasantham,
            COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM redemptions r2 WHERE r2.customer_id = r.customer_id AND r2.business_id NOT IN (bz.id, ?)
                   AND r2.status IN ${DONE} AND date(r2.approved_at, ${IST}) BETWEEN ? AND ?) THEN r.customer_id END) also_other_partners
       FROM businesses bz JOIN redemptions r ON r.business_id = bz.id AND r.status IN ${DONE} AND date(r.approved_at, ${IST}) BETWEEN ? AND ?
      WHERE bz.is_program_owner = 0 AND (? IS NULL OR bz.id = ?)
      GROUP BY bz.id ORDER BY customers DESC`,
    owner.id, from, to, owner.id, from, to, from, to, businessId, businessId,
  );
  const ecosystem = get(
    `SELECT COUNT(DISTINCT r.customer_id) redeeming_elsewhere,
            COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM purchases p JOIN branches b ON b.id = p.branch_id
               WHERE p.customer_id = r.customer_id AND p.bill_type = 'SALE' AND b.business_id = ?) THEN r.customer_id END) vasantham_shoppers
       FROM redemptions r WHERE r.business_id <> ? AND r.status IN ${DONE} AND date(r.approved_at, ${IST}) BETWEEN ? AND ? AND (? IS NULL OR r.business_id = ?)`,
    owner.id, owner.id, from, to, businessId, businessId,
  );
  ecosystem.multi_business = get(
    `SELECT COUNT(*) n FROM (
       SELECT customer_id FROM (
         SELECT p.customer_id, b.business_id FROM purchases p JOIN branches b ON b.id = p.branch_id
          WHERE p.customer_id IS NOT NULL AND p.bill_type = 'SALE' AND p.bill_date BETWEEN ? AND ?
         UNION SELECT customer_id, business_id FROM redemptions WHERE status IN ${DONE} AND date(approved_at, ${IST}) BETWEEN ? AND ?)
       GROUP BY customer_id HAVING COUNT(DISTINCT business_id) >= 2)`,
    from, to, from, to,
  ).n;

  const out = {
    from, to, business_id: businessId, business_name: bizName,
    key_metric: {
      linked_revenue_paise: tot.linked_revenue_paise,
      reward_value_paise: tot.reward_value_paise,
      ratio: tot.revenue_to_reward,
      note: 'Revenue on bills where a reward was used ÷ value of rewards used. An operational efficiency measure, not incremental revenue.',
    },
    redemptions: tot,
    per_business: perBusiness,
    first_time: firstTime,
    repeat,
    movement,
    ecosystem,
    trend: trend(to, businessId),
  };
  if (scoped) return out; // customer-base, referral and challenge figures are Vasantham-wide

  /* customer base, frequency and spend (Vasantham purchases) */
  const members = get(
    `SELECT (SELECT COUNT(*) FROM customers) total,
            (SELECT COUNT(*) FROM customers WHERE date(enrolled_at, ${IST}) BETWEEN ? AND ?) new_members,
            (SELECT COUNT(*) FROM customers WHERE app_registered_at IS NOT NULL) app_users`,
    from, to,
  );
  const shop = get(
    `SELECT COUNT(DISTINCT p.customer_id) shoppers, COUNT(*) bills, COALESCE(SUM(p.net_paise), 0) revenue
       FROM purchases p JOIN branches b ON b.id = p.branch_id
      WHERE p.customer_id IS NOT NULL AND p.bill_type = 'SALE' AND b.business_id = ? AND p.bill_date BETWEEN ? AND ?`,
    owner.id, from, to,
  );
  const active = get(
    `SELECT COUNT(*) n FROM (SELECT p.customer_id FROM purchases p WHERE p.customer_id IS NOT NULL AND p.bill_type = 'SALE' AND p.bill_date BETWEEN ? AND ?
       UNION SELECT customer_id FROM redemptions WHERE status IN ${DONE} AND date(approved_at, ${IST}) BETWEEN ? AND ?)`,
    from, to, from, to,
  ).n;
  const earned = get(
    `SELECT COALESCE(SUM(CASE WHEN type IN ('EARN','BONUS') THEN cp END), 0) earned,
            -COALESCE(SUM(CASE WHEN type IN ('REDEEM','REDEEM_REVERSAL') THEN cp END), 0) redeemed
       FROM points_ledger WHERE date(created_at, ${IST}) BETWEEN ? AND ?`,
    from, to,
  );
  const nonRewardBill = get(
    `SELECT AVG(p.net_paise) v FROM purchases p JOIN branches b ON b.id = p.branch_id
      WHERE p.customer_id IS NOT NULL AND p.bill_type = 'SALE' AND b.business_id = ? AND p.bill_date BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM redemptions r WHERE r.purchase_id = p.id)`,
    owner.id, from, to,
  ).v;
  out.customers = {
    ...members,
    active,
    shoppers: shop.shoppers,
    bills: shop.bills,
    member_revenue_paise: shop.revenue,
    visits_per_shopper: ratio(shop.bills, shop.shoppers),
    spend_per_shopper_paise: shop.shoppers ? Math.round(shop.revenue / shop.shoppers) : null,
    avg_bill_paise: shop.bills ? Math.round(shop.revenue / shop.bills) : null,
    avg_bill_without_reward_paise: nonRewardBill != null ? Math.round(nonRewardBill) : null,
    redemption_rate: ratio(tot.customers, active),
    points_earned_cp: earned.earned,
    points_redeemed_cp: earned.redeemed,
    points_redemption_rate: ratio(earned.redeemed, earned.earned),
    points_redeemed_value_paise: cpToPaise(earned.redeemed),
  };

  /* dormant customer recovery: came back after a long gap, and reactivation automations */
  const gap = Math.max(1, Math.round(setting('seg_active_days'))); // back after longer than the "active" window
  out.recovery = {
    gap_days: gap,
    win_backs: get(
      `SELECT COUNT(DISTINCT customer_id) n FROM (
         SELECT p.customer_id, p.bill_date, LAG(p.bill_date) OVER (PARTITION BY p.customer_id ORDER BY p.bill_date, p.id) prev
           FROM purchases p WHERE p.customer_id IS NOT NULL AND p.bill_type = 'SALE' AND p.bill_date <= ?)
        WHERE bill_date BETWEEN ? AND ? AND prev IS NOT NULL AND julianday(bill_date) - julianday(prev) >= ?`,
      to, from, to, gap,
    ).n,
    ...get(
      `SELECT COUNT(*) targeted,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM purchases p WHERE p.customer_id = t.customer_id AND p.bill_type = 'SALE'
                   AND p.bill_date >= t.target_date AND p.bill_date <= date(t.target_date, '+' || a.window_days || ' days')) THEN 1 ELSE 0 END) recovered
         FROM automation_targets t JOIN automations a ON a.id = t.automation_id WHERE t.target_date BETWEEN ? AND ?`,
      from, to,
    ),
  };
  out.recovery.recovered ||= 0;
  out.recovery.recovery_rate = ratio(out.recovery.recovered, out.recovery.targeted);

  /* referrals */
  out.referrals = get(
    `SELECT COUNT(*) created,
            SUM(CASE WHEN status = 'REWARDED' THEN 1 ELSE 0 END) converted,
            SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) pending,
            SUM(CASE WHEN status IN ('REJECTED','EXPIRED') THEN 1 ELSE 0 END) lost
       FROM referrals WHERE date(created_at, ${IST}) BETWEEN ? AND ?`,
    from, to,
  );
  out.referrals.converted_in_period = get(`SELECT COUNT(*) n FROM referrals WHERE status = 'REWARDED' AND date(qualified_at, ${IST}) BETWEEN ? AND ?`, from, to).n;
  out.referrals.conversion_rate = ratio(out.referrals.converted || 0, out.referrals.created);

  /* milestone and visit-challenge completion */
  out.challenges = all(
    `SELECT c.id, c.name, c.type,
            (SELECT COUNT(DISTINCT customer_id) FROM customer_challenge_progress g WHERE g.challenge_id = c.id AND g.progress > 0 AND date(g.updated_at, ${IST}) BETWEEN ? AND ?) participants,
            (SELECT COUNT(DISTINCT customer_id) FROM challenge_awards w WHERE w.challenge_id = c.id AND date(w.awarded_at, ${IST}) BETWEEN ? AND ?) completers,
            (SELECT COUNT(*) FROM challenge_awards w WHERE w.challenge_id = c.id AND date(w.awarded_at, ${IST}) BETWEEN ? AND ?) awards
       FROM challenges c WHERE c.valid_from <= ? AND c.valid_to >= ? ORDER BY c.type, c.id`,
    from, to, from, to, from, to, to, from,
  ).map((c) => ({ ...c, completion_rate: ratio(c.completers, c.participants) }));
  const byType = (t) => {
    const cs = out.challenges.filter((c) => c.type === t);
    const p = cs.reduce((s, c) => s + c.participants, 0);
    const k = cs.reduce((s, c) => s + c.completers, 0);
    return { participants: p, completers: k, completion_rate: ratio(k, p) };
  };
  out.milestone_completion = byType('SPEND');
  out.visit_completion = byType('VISITS');

  /* campaigns running in the period */
  out.campaigns = all('SELECT id FROM campaigns WHERE start_date <= ? AND end_date >= ? ORDER BY id DESC LIMIT 20', to, from).map(({ id }) => {
    const r = campaignReport(id);
    return {
      id, name: r.campaign.name, segment: r.campaign.segment, business: r.offer ? get('SELECT name FROM businesses WHERE id = ?', r.offer.business_id)?.name : null,
      audience: r.audience_size, returned: r.returned_customers, return_rate: r.return_rate, redeemed: r.redeemed_customers, redemption_rate: r.redemption_rate,
      revenue_paise: r.revenue_paise, cost_paise: r.discount_cost_paise,
    };
  });
  return out;
}

/** Six months up to `to`: active members, reward value used, redemption-linked revenue and the ratio. */
function trend(to, businessId) {
  const months = [];
  let m = `${to.slice(0, 7)}-01`;
  for (let i = 0; i < 6; i++) {
    const start = m;
    const end = addDays(`${nextMonth(start)}`, -1);
    months.unshift({ month: start.slice(0, 7), from: start, to: end > to ? to : end });
    m = prevMonth(start);
  }
  return months.map((x) => {
    const s = redemptionStats(x.from, x.to, businessId);
    const t = sumRows(s, ['redemptions', 'reward_value_paise', 'linked_revenue_paise']);
    const active = businessId
      ? get(`SELECT COUNT(DISTINCT customer_id) n FROM redemptions WHERE business_id = ? AND status IN ${DONE} AND date(approved_at, ${IST}) BETWEEN ? AND ?`, businessId, x.from, x.to).n
      : get("SELECT COUNT(DISTINCT customer_id) n FROM purchases WHERE customer_id IS NOT NULL AND bill_type = 'SALE' AND bill_date BETWEEN ? AND ?", x.from, x.to).n;
    return { month: x.month, active_customers: active, ...t, ratio: ratio(t.linked_revenue_paise, t.reward_value_paise) };
  });
}
function nextMonth(d) {
  const [y, mo] = d.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
}
function prevMonth(d) {
  const [y, mo] = d.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12-01` : `${y}-${String(mo - 1).padStart(2, '0')}-01`;
}

export const defaultPeriod = () => ({ from: `${istDate().slice(0, 7)}-01`, to: istDate() });
