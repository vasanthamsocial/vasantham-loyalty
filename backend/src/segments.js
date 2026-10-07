import { all, db, get, insertRows, run, setting, tx } from './db.js';
import { addDays, daysBetween, istDate, nowIso } from './util.js';

export const SEGMENTS = {
  NEW: 'New customer',
  ACTIVE: 'Active customer',
  REGULAR: 'Regular customer',
  HIGH_VALUE: 'High-value customer',
  OVERDUE: 'Overdue (past usual visit gap)',
  DORMANT: 'Dormant customer',
  LOST: 'Lost customer',
  FREQ_DECLINE: 'Frequency decline',
  SPEND_DECLINE: 'Spend decline',
  WEEKEND: 'Weekend shopper',
  MONTHLY: 'Monthly shopper',
  NO_PURCHASE: 'Enrolled, no purchase yet',
  APP_USER: 'App user',
};
export function segmentLabel(s) {
  if (SEGMENTS[s]) return SEGMENTS[s];
  if (s.startsWith('CAT:')) return `Category buyer: ${s.slice(4)}`;
  if (s.startsWith('INT:')) return `Interest: ${get('SELECT name FROM interest_segments WHERE code = ?', s.slice(4))?.name || s.slice(4)}`;
  return s;
}

/**
 * Admin-defined interest segments (INT:<code>): customers whose recent Vasantham baskets lean
 * towards some categories / products, e.g. nuts & health foods → MF Nuts offers.
 * Rules, not AI: management controls the categories, keywords and thresholds.
 */
function interestSegments(asOf) {
  const out = []; // [customerId, segment]
  for (const r of all('SELECT * FROM interest_segments WHERE active = 1')) {
    const cats = (r.categories || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const words = (r.keywords || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!cats.length && !words.length) continue;
    const conds = [
      ...(cats.length ? [`lower(i.category) IN (${cats.map(() => '?').join(',')})`] : []),
      ...words.map(() => "lower(COALESCE(i.product_name,'')) LIKE ?"),
    ];
    const rows = all(
      `SELECT p.customer_id cid, SUM(i.amount_paise) total, SUM(CASE WHEN ${conds.join(' OR ')} THEN i.amount_paise ELSE 0 END) matched
         FROM purchase_items i JOIN purchases p ON p.id = i.purchase_id
        WHERE p.customer_id IS NOT NULL AND p.bill_type = 'SALE' AND p.bill_date > ? AND p.bill_date <= ?
        GROUP BY p.customer_id`,
      ...cats, ...words.map((w) => `%${w}%`), addDays(asOf, -r.lookback_days), asOf,
    );
    for (const x of rows) {
      if (x.total > 0 && x.matched > 0 && x.matched >= r.min_spend_paise && x.matched / x.total >= r.min_share) out.push([x.cid, `INT:${r.code}`]);
    }
  }
  return out;
}

/**
 * Recalculate every customer's segments from purchase history.
 * Thresholds come from the settings table (editable in the admin panel).
 */
export function recomputeSegments(asOf = istDate()) {
  const S = {
    newDays: setting('seg_new_days'),
    activeDays: setting('seg_active_days'),
    dormantDays: setting('seg_dormant_days'),
    regularVisits: setting('seg_regular_min_visits_90d'),
    highValuePaise: setting('seg_high_value_spend_90d') * 100,
    decline: setting('seg_decline_ratio'),
    weekendShare: setting('seg_weekend_share'),
    catShare: setting('seg_category_share'),
    overdueFactor: setting('seg_overdue_factor'),
  };
  const d90 = addDays(asOf, -90);
  const d180 = addDays(asOf, -180);

  const rows = all(
    `SELECT c.id, c.app_registered_at,
       MIN(p.bill_date) first_d, MAX(p.bill_date) last_d, COUNT(p.id) vtot,
       SUM(CASE WHEN p.bill_date > ? THEN 1 ELSE 0 END) v90,
       SUM(CASE WHEN p.bill_date > ? THEN p.net_paise ELSE 0 END) s90,
       SUM(CASE WHEN p.bill_date <= ? AND p.bill_date > ? THEN 1 ELSE 0 END) vp90,
       SUM(CASE WHEN p.bill_date <= ? AND p.bill_date > ? THEN p.net_paise ELSE 0 END) sp90,
       SUM(CASE WHEN strftime('%w', p.bill_date) IN ('0','6') THEN 1 ELSE 0 END) wk,
       COUNT(DISTINCT CASE WHEN p.bill_date > ? THEN substr(p.bill_date,1,7) END) m90
     FROM customers c
     LEFT JOIN purchases p ON p.customer_id = c.id AND p.bill_type = 'SALE' AND p.bill_date <= ?
     GROUP BY c.id`,
    d90, d90, d90, d180, d90, d180, d90, asOf,
  );

  // top category share over the last 180 days (only when item-level data exists)
  const cats = new Map();
  for (const r of all(
    `SELECT p.customer_id cid, i.category, SUM(i.amount_paise) amt
       FROM purchase_items i JOIN purchases p ON p.id = i.purchase_id
      WHERE p.customer_id IS NOT NULL AND p.bill_type = 'SALE' AND p.bill_date > ? AND i.category IS NOT NULL
      GROUP BY p.customer_id, i.category`,
    d180,
  )) {
    const c = cats.get(r.cid) || { total: 0, top: null, topAmt: 0 };
    c.total += r.amt || 0;
    if ((r.amt || 0) > c.topAmt) Object.assign(c, { top: r.category, topAmt: r.amt });
    cats.set(r.cid, c);
  }

  const now = nowIso();
  tx(() => {
    db.exec('DELETE FROM customer_segments');
    const out = [];
    const ins = { run: (cid, seg, at) => out.push([cid, seg, at]) };
    for (const r of rows) {
      const segs = [];
      if (r.app_registered_at) segs.push('APP_USER');
      if (!r.vtot) {
        segs.push('NO_PURCHASE');
      } else {
        const since = daysBetween(r.last_d, asOf);
        if (daysBetween(r.first_d, asOf) < S.newDays) segs.push('NEW');
        // usually shops every N days but is now well past that gap (before becoming lost)
        if (r.vtot >= 3 && since < S.dormantDays * 2) {
          const gap = daysBetween(r.first_d, r.last_d) / (r.vtot - 1);
          if (since >= Math.max(14, gap * S.overdueFactor)) segs.push('OVERDUE');
        }
        if (since < S.activeDays) segs.push('ACTIVE');
        else if (since < S.dormantDays) segs.push('DORMANT');
        else segs.push('LOST');
        if (r.v90 >= S.regularVisits) segs.push('REGULAR');
        if (r.s90 >= S.highValuePaise) segs.push('HIGH_VALUE');
        if (r.vp90 >= 3 && r.v90 < r.vp90 * S.decline) segs.push('FREQ_DECLINE');
        if (r.sp90 > 0 && r.s90 < r.sp90 * S.decline) segs.push('SPEND_DECLINE');
        if (r.vtot >= 3 && r.wk / r.vtot >= S.weekendShare) segs.push('WEEKEND');
        if (r.m90 >= 3 && r.v90 <= 6) segs.push('MONTHLY');
        const c = cats.get(r.id);
        if (c && c.total > 0 && c.topAmt / c.total >= S.catShare) segs.push(`CAT:${c.top}`);
      }
      for (const s of segs) ins.run(r.id, s, now);
    }
    for (const [cid, seg] of interestSegments(asOf)) ins.run(cid, seg, now);
    insertRows('customer_segments', ['customer_id', 'segment', 'computed_at'], out);
  });
  run("INSERT INTO settings(key, value) VALUES ('segments_computed_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(Date.now()));
  return rows.length;
}

export function segmentCounts() {
  return all('SELECT segment, COUNT(*) n FROM customer_segments GROUP BY segment ORDER BY n DESC').map((r) => ({ ...r, label: segmentLabel(r.segment) }));
}

export function customersInSegment(segment) {
  if (segment === 'ALL') return all("SELECT id FROM customers WHERE status = 'ACTIVE'").map((r) => r.id);
  return all("SELECT s.customer_id id FROM customer_segments s JOIN customers c ON c.id = s.customer_id WHERE s.segment = ? AND c.status = 'ACTIVE'", segment).map((r) => r.id);
}
