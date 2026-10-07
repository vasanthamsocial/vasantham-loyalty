import { all, get, setting } from './db.js';
import { CONFIG } from './config.js';
import { addDays, cpToPaise, daysBetween, istDate } from './util.js';
import { missingBills } from './reconcile.js';

const DONE = "('APPROVED','SUBMITTED','BILLED','RECONCILED')";

export function liability() {
  const r = get('SELECT COALESCE(SUM(CASE WHEN balance_cp > 0 THEN balance_cp END),0) cp, COUNT(CASE WHEN balance_cp > 0 THEN 1 END) holders FROM customers');
  const month = istDate().slice(0, 7);
  const flow = all(
    `SELECT substr(date(created_at,'+330 minutes'),1,7) month,
            SUM(CASE WHEN type IN ('EARN','BONUS') THEN cp ELSE 0 END) issued_cp,
            -SUM(CASE WHEN type IN ('REDEEM','REDEEM_REVERSAL') THEN cp ELSE 0 END) redeemed_cp,
            -SUM(CASE WHEN type = 'RETURN_REVERSAL' THEN cp ELSE 0 END) reversed_cp,
            SUM(CASE WHEN type = 'ADJUST' THEN cp ELSE 0 END) adjusted_cp
       FROM points_ledger GROUP BY month ORDER BY month DESC LIMIT 12`,
  );
  const bands = all(
    `SELECT CASE WHEN balance_cp < 1000 THEN '0 – 10' WHEN balance_cp < 5000 THEN '10 – 50' WHEN balance_cp < 10000 THEN '50 – 100'
                 WHEN balance_cp < 50000 THEN '100 – 500' ELSE '500+' END band,
            COUNT(*) customers, SUM(balance_cp) cp
       FROM customers WHERE balance_cp > 0 GROUP BY band ORDER BY MIN(balance_cp)`,
  );
  return {
    outstanding_cp: r.cp,
    liability_paise: cpToPaise(r.cp),
    holders: r.holders,
    point_value_rupees: CONFIG.pointValueRupees,
    rupees_per_point: CONFIG.rupeesPerPoint,
    this_month: flow.find((f) => f.month === month) || null,
    monthly: flow,
    bands,
  };
}

export function dashboard() {
  const today = istDate();
  const from30 = addDays(today, -29);
  const active = setting('seg_active_days');
  const dormant = setting('seg_dormant_days');
  const c = get(
    `SELECT COUNT(*) total,
       SUM(CASE WHEN app_registered_at IS NOT NULL THEN 1 ELSE 0 END) app_users,
       SUM(CASE WHEN last_purchase_date > ? THEN 1 ELSE 0 END) active,
       SUM(CASE WHEN last_purchase_date <= ? AND last_purchase_date > ? THEN 1 ELSE 0 END) dormant,
       SUM(CASE WHEN last_purchase_date <= ? THEN 1 ELSE 0 END) lost,
       SUM(CASE WHEN date(enrolled_at,'+330 minutes') >= ? THEN 1 ELSE 0 END) new_30d
     FROM customers`,
    addDays(today, -active), addDays(today, -active), addDays(today, -dormant), addDays(today, -dormant), from30,
  );
  const sales = get(
    `SELECT COUNT(*) bills, COALESCE(SUM(net_paise),0) sales,
       COALESCE(SUM(CASE WHEN customer_id IS NOT NULL THEN net_paise END),0) member_sales,
       SUM(CASE WHEN customer_id IS NOT NULL THEN 1 ELSE 0 END) member_bills
     FROM purchases WHERE bill_type = 'SALE' AND bill_date >= ?`,
    from30,
  );
  const daily = all(
    `SELECT bill_date d, SUM(CASE WHEN customer_id IS NOT NULL THEN net_paise ELSE 0 END) member, SUM(CASE WHEN customer_id IS NULL THEN net_paise ELSE 0 END) non_member
       FROM purchases WHERE bill_type = 'SALE' AND bill_date >= ? GROUP BY bill_date ORDER BY bill_date`,
    from30,
  );
  const red = get(
    `SELECT SUM(CASE WHEN date(approved_at,'+330 minutes') = ? THEN 1 ELSE 0 END) today_count,
            COALESCE(SUM(CASE WHEN date(approved_at,'+330 minutes') = ? THEN value_paise END),0) today_value,
            COALESCE(SUM(CASE WHEN date(approved_at,'+330 minutes') >= ? THEN value_paise END),0) value_30d,
            SUM(CASE WHEN date(approved_at,'+330 minutes') >= ? THEN 1 ELSE 0 END) count_30d
       FROM redemptions WHERE status IN ${DONE}`,
    today, today, from30, from30,
  );
  const lastImport = get('SELECT id, filename, uploaded_at, status, max_bill_date FROM imports ORDER BY id DESC LIMIT 1');
  const openIssues = get('SELECT COUNT(*) n FROM recon_issues WHERE resolved_at IS NULL').n;
  return {
    customers: c,
    sales_30d: sales,
    daily,
    redemptions: red,
    liability: liability(),
    last_import: lastImport,
    open_recon_issues: openIssues + missingBills().length,
    pending_reconciliation: get("SELECT COUNT(*) n FROM redemptions WHERE status IN ('APPROVED','SUBMITTED','BILLED')").n,
  };
}

export function customerAnalytics() {
  const today = istDate();
  const d90 = addDays(today, -90);
  const t = get(
    `SELECT COUNT(DISTINCT customer_id) buyers, COUNT(*) bills, COALESCE(SUM(net_paise),0) spend
       FROM purchases WHERE bill_type = 'SALE' AND customer_id IS NOT NULL`,
  );
  const repeat = get(`SELECT COUNT(*) n FROM (SELECT customer_id FROM purchases WHERE bill_type='SALE' AND customer_id IS NOT NULL GROUP BY customer_id HAVING COUNT(*) >= 2)`).n;
  const r90 = get(
    `SELECT COUNT(DISTINCT customer_id) buyers, COUNT(*) bills, COALESCE(SUM(net_paise),0) spend
       FROM purchases WHERE bill_type='SALE' AND customer_id IS NOT NULL AND bill_date > ?`,
    d90,
  );
  const monthly = all(
    `SELECT substr(bill_date,1,7) month, COUNT(DISTINCT customer_id) customers, COUNT(*) bills, SUM(net_paise) spend
       FROM purchases WHERE bill_type='SALE' AND customer_id IS NOT NULL GROUP BY month ORDER BY month DESC LIMIT 12`,
  ).map((m) => ({ ...m, spend_per_customer: m.customers ? Math.round(m.spend / m.customers) : 0 }));
  const top = all(
    `SELECT c.id, c.code, c.name, c.mobile, c.last_purchase_date, COUNT(p.id) visits, SUM(p.net_paise) lifetime_paise
       FROM customers c JOIN purchases p ON p.customer_id = c.id AND p.bill_type = 'SALE'
      GROUP BY c.id ORDER BY lifetime_paise DESC LIMIT 20`,
  );
  const categories = all(
    `SELECT i.category, COUNT(DISTINCT p.customer_id) customers, SUM(i.amount_paise) spend
       FROM purchase_items i JOIN purchases p ON p.id = i.purchase_id
      WHERE p.customer_id IS NOT NULL AND p.bill_type='SALE' AND i.category IS NOT NULL
      GROUP BY i.category ORDER BY spend DESC LIMIT 15`,
  );
  const total = get('SELECT COUNT(*) n FROM customers').n;
  return {
    total_customers: total,
    buyers: t.buyers,
    repeat_customers: repeat,
    repeat_rate: t.buyers ? repeat / t.buyers : 0,
    avg_bill_paise: t.bills ? Math.round(t.spend / t.bills) : 0,
    avg_lifetime_value_paise: t.buyers ? Math.round(t.spend / t.buyers) : 0,
    visits_per_customer_90d: r90.buyers ? r90.bills / r90.buyers : 0,
    monthly_visit_frequency: r90.buyers ? r90.bills / r90.buyers / 3 : 0,
    monthly,
    top,
    categories,
  };
}

/** Per-customer CRM insights (admin customer page). */
export function customerInsights(customerId) {
  const today = istDate();
  const d90 = addDays(today, -90);
  const d180 = addDays(today, -180);
  const r = get(
    `SELECT COUNT(*) visits, COALESCE(SUM(net_paise),0) lifetime, MAX(bill_date) last_d, MIN(bill_date) first_d,
       SUM(CASE WHEN bill_date > ? THEN 1 ELSE 0 END) v90, COALESCE(SUM(CASE WHEN bill_date > ? THEN net_paise END),0) s90,
       SUM(CASE WHEN bill_date <= ? AND bill_date > ? THEN 1 ELSE 0 END) vp90,
       COALESCE(SUM(CASE WHEN bill_date <= ? AND bill_date > ? THEN net_paise END),0) sp90
     FROM purchases WHERE customer_id = ? AND bill_type = 'SALE'`,
    d90, d90, d90, d180, d90, d180, customerId,
  );
  const cats = all(
    `SELECT i.category, SUM(i.amount_paise) spend FROM purchase_items i JOIN purchases p ON p.id = i.purchase_id
      WHERE p.customer_id = ? AND p.bill_type='SALE' AND i.category IS NOT NULL GROUP BY i.category ORDER BY spend DESC LIMIT 5`,
    customerId,
  );
  const branches = all(
    `SELECT b.name, COUNT(*) visits, SUM(p.net_paise) spend FROM purchases p JOIN branches b ON b.id = p.branch_id
      WHERE p.customer_id = ? AND p.bill_type='SALE' GROUP BY b.id ORDER BY visits DESC`,
    customerId,
  );
  const trend = (a, b) => (b === 0 ? (a > 0 ? 'up' : 'flat') : a / b >= 1.1 ? 'up' : a / b <= 0.9 ? 'down' : 'flat');
  return {
    visits: r.visits,
    lifetime_value_paise: r.lifetime,
    avg_bill_paise: r.visits ? Math.round(r.lifetime / r.visits) : 0,
    first_purchase_date: r.first_d,
    last_purchase_date: r.last_d,
    days_since_last: r.last_d ? daysBetween(r.last_d, today) : null,
    visits_90d: r.v90,
    spend_90d_paise: r.s90,
    visits_prev_90d: r.vp90,
    spend_prev_90d_paise: r.sp90,
    frequency_trend: trend(r.v90, r.vp90),
    spend_trend: trend(r.s90, r.sp90),
    categories: cats,
    branches,
  };
}

export function branchAnalytics(from, to) {
  const branches = all('SELECT id, code, name FROM branches ORDER BY name');
  const sales = new Map(all(
    `SELECT branch_id,
       COUNT(*) bills, COALESCE(SUM(net_paise),0) sales,
       COALESCE(SUM(CASE WHEN customer_id IS NOT NULL THEN net_paise END),0) member_sales,
       COALESCE(SUM(CASE WHEN customer_id IS NULL THEN net_paise END),0) non_member_sales,
       COALESCE(SUM(CASE WHEN loyalty_ref IS NOT NULL AND loyalty_ref <> '' THEN net_paise END),0) loyalty_linked_sales,
       SUM(CASE WHEN customer_id IS NOT NULL THEN 1 ELSE 0 END) member_bills,
       COUNT(DISTINCT customer_id) identified
     FROM purchases WHERE bill_type = 'SALE' AND bill_date BETWEEN ? AND ? GROUP BY branch_id`,
    from, to,
  ).map((r) => [r.branch_id, r]));
  // new = first-ever purchase (any branch) falls in range at this branch; repeat = bought before range or 2+ times in range
  const custs = new Map(all(
    `SELECT p.branch_id,
       COUNT(DISTINCT CASE WHEN c.first_purchase_date BETWEEN ? AND ? THEN p.customer_id END) new_customers,
       COUNT(DISTINCT CASE WHEN c.first_purchase_date < ? THEN p.customer_id END) returning_customers
     FROM purchases p JOIN customers c ON c.id = p.customer_id
     WHERE p.bill_type = 'SALE' AND p.bill_date BETWEEN ? AND ? GROUP BY p.branch_id`,
    from, to, from, from, to,
  ).map((r) => [r.branch_id, r]));
  const multi = new Map(all(
    `SELECT branch_id, COUNT(*) n FROM (SELECT branch_id, customer_id FROM purchases WHERE bill_type='SALE' AND customer_id IS NOT NULL AND bill_date BETWEEN ? AND ?
       GROUP BY branch_id, customer_id HAVING COUNT(*) >= 2) GROUP BY branch_id`,
    from, to,
  ).map((r) => [r.branch_id, r.n]));
  const points = new Map(all(
    `SELECT l.branch_id,
       SUM(CASE WHEN l.type IN ('EARN','BONUS') THEN l.cp ELSE 0 END) issued_cp,
       SUM(CASE WHEN l.type = 'RETURN_REVERSAL' THEN -l.cp ELSE 0 END) reversed_cp
     FROM points_ledger l LEFT JOIN purchases p ON p.id = l.purchase_id
     WHERE COALESCE(p.bill_date, date(l.created_at,'+330 minutes')) BETWEEN ? AND ? GROUP BY l.branch_id`,
    from, to,
  ).map((r) => [r.branch_id, r]));
  const red = new Map(all(
    `SELECT branch_id, COUNT(*) redemptions,
       SUM(CASE WHEN kind='POINTS' THEN cp ELSE 0 END) redeemed_cp,
       SUM(CASE WHEN kind='POINTS' THEN value_paise ELSE 0 END) points_value,
       SUM(CASE WHEN kind='OFFER' THEN 1 ELSE 0 END) offer_redemptions,
       SUM(CASE WHEN kind='OFFER' THEN value_paise ELSE 0 END) offer_value
     FROM redemptions WHERE status IN ${DONE} AND date(approved_at,'+330 minutes') BETWEEN ? AND ? GROUP BY branch_id`,
    from, to,
  ).map((r) => [r.branch_id, r]));

  return branches.map((b) => {
    const s = sales.get(b.id) || {};
    const c = custs.get(b.id) || {};
    const p = points.get(b.id) || {};
    const r = red.get(b.id) || {};
    const loyaltyCost = (r.points_value || 0) + (r.offer_value || 0);
    return {
      branch_id: b.id, code: b.code, name: b.name,
      bills: s.bills || 0,
      sales_paise: s.sales || 0,
      member_sales_paise: s.member_sales || 0,
      non_member_sales_paise: s.non_member_sales || 0,
      loyalty_linked_sales_paise: s.loyalty_linked_sales || 0,
      member_share: s.sales ? s.member_sales / s.sales : 0,
      identified_customers: s.identified || 0,
      new_customers: c.new_customers || 0,
      repeat_customers: Math.max(c.returning_customers || 0, multi.get(b.id) || 0),
      points_issued_cp: p.issued_cp || 0,
      points_reversed_cp: p.reversed_cp || 0,
      points_redeemed_cp: r.redeemed_cp || 0,
      redemptions: r.redemptions || 0,
      offer_redemptions: r.offer_redemptions || 0,
      loyalty_cost_paise: loyaltyCost,
      avg_bill_paise: s.bills ? Math.round(s.sales / s.bills) : 0,
      redemption_rate: s.member_bills ? (r.redemptions || 0) / s.member_bills : 0,
      loyalty_cost_pct: s.sales ? loyaltyCost / s.sales : 0,
    };
  });
}

export function campaignReport(campaignId) {
  const c = get('SELECT * FROM campaigns WHERE id = ?', campaignId);
  if (!c) return null;
  const o = get('SELECT * FROM offers WHERE id = ?', c.offer_id);
  const audience = get('SELECT COUNT(*) n FROM offer_assignments WHERE campaign_id = ?', c.id).n;
  const window = [c.start_date, c.end_date];
  const returned = get(
    `SELECT COUNT(DISTINCT p.customer_id) customers, COUNT(p.id) bills, COALESCE(SUM(p.net_paise),0) revenue
       FROM purchases p JOIN offer_assignments a ON a.customer_id = p.customer_id AND a.campaign_id = ?
      WHERE p.bill_type='SALE' AND p.bill_date BETWEEN ? AND ?`,
    c.id, ...window,
  );
  const redeemed = get(
    `SELECT COUNT(DISTINCT customer_id) customers, COUNT(*) n, COALESCE(SUM(value_paise),0) cost
       FROM redemptions WHERE offer_id = ? AND status IN ${DONE}`,
    c.offer_id,
  );
  const bonus = get("SELECT COUNT(DISTINCT customer_id) customers, COUNT(DISTINCT purchase_id) n, COALESCE(SUM(cp),0) cp FROM points_ledger WHERE offer_id = ? AND type = 'BONUS'", c.offer_id);
  const isAuto = o && ['BONUS_POINTS', 'MULTIPLIER'].includes(o.type);
  const redeemers = isAuto ? bonus.customers : redeemed.customers;
  const cost = isAuto ? cpToPaise(bonus.cp) : redeemed.cost;
  // revenue from customers who actually used the offer
  const redeemerRevenue = get(
    `SELECT COALESCE(SUM(p.net_paise),0) revenue, COUNT(p.id) bills FROM purchases p
      WHERE p.bill_type='SALE' AND p.bill_date BETWEEN ? AND ? AND p.customer_id IN (
        SELECT customer_id FROM redemptions WHERE offer_id = ? AND status IN ${DONE}
        UNION SELECT customer_id FROM points_ledger WHERE offer_id = ? AND type='BONUS')`,
    ...window, c.offer_id, c.offer_id,
  );
  const branches = all(
    `SELECT b.name, COUNT(DISTINCT p.customer_id) customers, SUM(p.net_paise) revenue
       FROM purchases p JOIN offer_assignments a ON a.customer_id = p.customer_id AND a.campaign_id = ?
       JOIN branches b ON b.id = p.branch_id
      WHERE p.bill_type='SALE' AND p.bill_date BETWEEN ? AND ? GROUP BY b.id ORDER BY revenue DESC`,
    c.id, ...window,
  );
  return {
    campaign: c,
    offer: o,
    audience_size: audience,
    returned_customers: returned.customers,
    return_rate: audience ? returned.customers / audience : 0,
    redeemed_customers: redeemers,
    redemption_rate: audience ? redeemers / audience : 0,
    revenue_paise: returned.revenue,
    redeemer_revenue_paise: redeemerRevenue.revenue,
    bills: returned.bills,
    avg_bill_paise: returned.bills ? Math.round(returned.revenue / returned.bills) : 0,
    discount_cost_paise: cost,
    roi: cost ? redeemerRevenue.revenue / cost : null,
    branches,
  };
}

export function managerDaily(branchId, date) {
  const r = get(
    `SELECT
       SUM(CASE WHEN status IN ${DONE} THEN 1 ELSE 0 END) redemptions,
       COALESCE(SUM(CASE WHEN status IN ${DONE} AND kind='POINTS' THEN cp END),0) points_cp,
       COALESCE(SUM(CASE WHEN status IN ${DONE} THEN value_paise END),0) value_paise,
       SUM(CASE WHEN status IN ${DONE} AND kind='OFFER' THEN 1 ELSE 0 END) offers,
       COALESCE(SUM(CASE WHEN status IN ${DONE} AND kind='OFFER' THEN value_paise END),0) offers_value_paise
     FROM redemptions WHERE branch_id = ? AND date(approved_at,'+330 minutes') = ?`,
    branchId, date,
  );
  const cancelled = get(
    `SELECT COUNT(*) n FROM redemption_events e JOIN redemptions r ON r.id = e.redemption_id
      WHERE e.to_status IN ('CANCELLED','REVERSED') AND e.actor_type <> 'SYSTEM' AND e.actor_type <> 'CUSTOMER'
        AND (r.branch_id = ? OR e.branch_id = ?) AND date(e.created_at,'+330 minutes') = ?`,
    branchId, branchId, date,
  ).n;
  const pending = get("SELECT COUNT(*) n, COALESCE(SUM(value_paise),0) v FROM redemptions WHERE branch_id = ? AND status IN ('APPROVED','SUBMITTED','BILLED')", branchId);
  return { date, ...r, cancelled, pending_reconciliation: pending.n, pending_value_paise: pending.v };
}
