import { all, get, run, tx } from './db.js';
import { audit } from './audit.js';
import { grantReward, normaliseReward, rewardLabel } from './rewards.js';
import { segmentLabel } from './segments.js';
import { HttpError, addDays, bad, fmtRupees, isDate, istDate, nowIso, toPaise } from './util.js';

/**
 * Challenges = spend milestones (type SPEND) and visit-frequency challenges (type VISITS).
 *
 * Each challenge measures a customer's purchases at a points-earning business over a period
 * (calendar month, Monday–Sunday week, or the whole campaign) and has reward tiers
 * (e.g. ₹2,500 → 10 bonus points, ₹5,000 → HOF ₹50 reward). Progress comes only from the
 * daily Excel upload; rewards are given automatically after each upload, once per tier per
 * period (or once ever when not repeatable). Rewards are not taken back if a later return
 * brings the total under the threshold.
 */
export const CHALLENGE_TYPES = { SPEND: 'Spend milestone', VISITS: 'Visit challenge' };
export const PERIODS = { MONTHLY: 'Every calendar month', WEEKLY: 'Every week (Mon–Sun)', CAMPAIGN: 'Whole campaign period' };

const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

/** The measurement period containing `date`, clipped to the challenge's validity; null if outside it. */
export function periodOf(ch, date) {
  if (date < ch.valid_from || date > ch.valid_to) return null;
  let key, from, to;
  if (ch.period === 'MONTHLY') {
    key = date.slice(0, 7);
    from = `${key}-01`;
    const [y, m] = key.split('-').map(Number);
    to = addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
  } else if (ch.period === 'WEEKLY') {
    from = addDays(date, -((dow(date) + 6) % 7));
    key = from;
    to = addDays(from, 6);
  } else {
    key = 'ALL';
    from = ch.valid_from;
    to = ch.valid_to;
  }
  return { key, from: from < ch.valid_from ? ch.valid_from : from, to: to > ch.valid_to ? ch.valid_to : to };
}

function branchFilter(ch) {
  const ids = ch.branch_ids ? ch.branch_ids.split(',').map(Number) : null;
  return {
    sql: `p.branch_id IN (SELECT id FROM branches WHERE business_id = ?)${ids ? ` AND p.branch_id IN (${ids.join(',')})` : ''}`,
    params: [ch.business_id],
  };
}

/** Progress for one customer in one period: net spend in paise, or distinct qualifying visit days. */
export function measure(ch, customerId, per) {
  const f = branchFilter(ch);
  if (ch.type === 'SPEND') {
    const v = get(
      `SELECT COALESCE(SUM(CASE p.bill_type WHEN 'SALE' THEN p.net_paise ELSE -p.net_paise END), 0) v
         FROM purchases p WHERE p.customer_id = ? AND p.bill_date BETWEEN ? AND ? AND ${f.sql}`,
      customerId, per.from, per.to, ...f.params,
    ).v;
    return { value: Math.max(0, v), visits: null };
  }
  const days = all(
    `SELECT DISTINCT p.bill_date d FROM purchases p
      WHERE p.customer_id = ? AND p.bill_type = 'SALE' AND p.net_paise >= ? AND p.bill_date BETWEEN ? AND ? AND ${f.sql} ORDER BY p.bill_date`,
    customerId, ch.min_bill_paise, per.from, per.to, ...f.params,
  ).map((r) => r.d);
  return { value: days.length, visits: days };
}

function eligible(ch, customerId) {
  const c = get('SELECT status FROM customers WHERE id = ?', customerId);
  if (!c || c.status !== 'ACTIVE') return false;
  return !ch.segment || !!get('SELECT 1 FROM customer_segments WHERE customer_id = ? AND segment = ?', customerId, ch.segment);
}

const tiersOf = (id) => all('SELECT * FROM challenge_tiers WHERE challenge_id = ? ORDER BY threshold', id);

function alreadyAwarded(ch, tier, customerId, key) {
  return ch.repeatable
    ? get('SELECT 1 FROM challenge_awards WHERE tier_id = ? AND customer_id = ? AND period_key = ?', tier.id, customerId, key)
    : get('SELECT 1 FROM challenge_awards WHERE tier_id = ? AND customer_id = ?', tier.id, customerId);
}

const fmtThreshold = (ch, t) => (ch.type === 'SPEND' ? fmtRupees(t) : `${t} visit${t === 1 ? '' : 's'}`);

/**
 * Update progress and give rewards. `byCustomer` maps customerId → bill dates just imported,
 * so every period touched by the upload is evaluated (a late upload of last month's bills
 * still completes last month's milestone).
 */
export function evaluateChallenges(byCustomer) {
  const today = istDate();
  const out = { progressed: 0, awards: 0 };
  const list = all('SELECT * FROM challenges WHERE active = 1');
  if (!list.length) return out;
  for (const ch of list) {
    const tiers = tiersOf(ch.id);
    if (!tiers.length) continue;
    for (const [customerId, dates] of byCustomer) {
      if (!eligible(ch, customerId)) continue;
      const periods = new Map();
      for (const d of dates) {
        const per = periodOf(ch, d);
        if (per && per.from <= today) periods.set(per.key, per);
      }
      for (const per of periods.values()) {
        tx(() => {
          const m = measure(ch, customerId, per);
          run(`INSERT INTO customer_challenge_progress(challenge_id, customer_id, period_key, progress, updated_at) VALUES (?,?,?,?,?)
               ON CONFLICT(challenge_id, customer_id, period_key) DO UPDATE SET progress = excluded.progress, updated_at = excluded.updated_at`,
          ch.id, customerId, per.key, m.value, nowIso());
          out.progressed++;
          for (const t of tiers) {
            if (m.value < t.threshold || alreadyAwarded(ch, t, customerId, per.key)) continue;
            const reward = { type: t.reward_type, cp: t.reward_cp, offer_id: t.reward_offer_id };
            const given = grantReward(customerId, reward, {
              source: 'CHALLENGE', title: `${ch.name}: reward unlocked`, note: `You reached ${fmtThreshold(ch, t.threshold)} (${ch.name})`, validDays: t.reward_valid_days,
            });
            if (!given) continue;
            run('INSERT INTO challenge_awards(challenge_id, tier_id, customer_id, period_key, reward_type, reward_cp, offer_id, awarded_at) VALUES (?,?,?,?,?,?,?,?)',
              ch.id, t.id, customerId, per.key, t.reward_type, t.reward_cp, t.reward_offer_id, nowIso());
            out.awards++;
          }
        });
      }
    }
  }
  return out;
}

/** What the Customer App shows: live progress in the current period for every challenge the customer can take part in. */
export function challengesFor(customer) {
  const today = istDate();
  return all('SELECT * FROM challenges WHERE active = 1 AND valid_from <= ? AND valid_to >= ? ORDER BY type, id', today, today)
    .filter((ch) => eligible(ch, customer.id))
    .map((ch) => {
      const per = periodOf(ch, today);
      const m = measure(ch, customer.id, per);
      const tiers = tiersOf(ch.id).map((t) => ({
        threshold: t.threshold,
        label: fmtThreshold(ch, t.threshold),
        reward: rewardLabel(t),
        achieved: !!alreadyAwarded(ch, t, customer.id, per.key) || m.value >= t.threshold,
      }));
      const next = tiers.find((t) => !t.achieved) || null;
      return {
        id: ch.id, name: ch.name, description: ch.description, type: ch.type, period: ch.period,
        period_from: per.from, period_to: per.to, days_left: Math.max(0, Math.round((new Date(per.to) - new Date(today)) / 864e5)),
        min_bill_paise: ch.min_bill_paise,
        progress: m.value, visits: m.visits,
        target: next ? next.threshold : tiers[tiers.length - 1]?.threshold,
        remaining: next ? next.threshold - m.value : 0,
        next_reward: next?.reward || null,
        tiers,
        completed: !next,
      };
    });
}

/* ---------- admin ---------- */

export function normaliseChallenge(b = {}) {
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) throw bad('Challenge name is required');
  const type = String(b.type || '').toUpperCase();
  if (!CHALLENGE_TYPES[type]) throw bad('Choose spend milestone or visit challenge');
  const period = String(b.period || 'MONTHLY').toUpperCase();
  if (!PERIODS[period]) throw bad('Choose the measurement period');
  const biz = b.business_id ? get('SELECT * FROM businesses WHERE id = ?', Number(b.business_id)) : get('SELECT * FROM businesses WHERE is_program_owner = 1');
  if (!biz || !biz.can_earn) throw bad('Challenges measure purchases at a business that earns points (e.g. Vasantham)');
  if (!isDate(b.valid_from) || !isDate(b.valid_to) || b.valid_to < b.valid_from) throw bad('Valid from / to dates are invalid');
  const segment = !b.segment || b.segment === 'ALL' ? null : String(b.segment);
  let branchIds = null;
  if (Array.isArray(b.branch_ids) && b.branch_ids.length) {
    const own = new Set(all('SELECT id FROM branches WHERE business_id = ?', biz.id).map((r) => r.id));
    if (b.branch_ids.some((id) => !own.has(Number(id)))) throw bad(`Participating branches must belong to ${biz.name}`);
    branchIds = b.branch_ids.map(Number).join(',');
  }
  const minBill = type === 'VISITS' ? toPaise(b.min_bill) ?? 0 : 0;
  if (minBill < 0) throw bad('Minimum bill cannot be negative');
  const tiers = (Array.isArray(b.tiers) ? b.tiers : []).map((t, i) => {
    const threshold = type === 'SPEND' ? toPaise(t.threshold) : parseInt(t.threshold, 10);
    if (!(threshold > 0)) throw bad(`Tier ${i + 1}: enter the ${type === 'SPEND' ? 'spend target (₹)' : 'number of visits'}`);
    const validDays = parseInt(t.valid_days || 30, 10);
    if (!(validDays >= 1 && validDays <= 365)) throw bad(`Tier ${i + 1}: reward validity must be 1–365 days`);
    return { threshold, reward: normaliseReward(t.reward, `Tier ${i + 1}`), valid_days: validDays };
  });
  if (!tiers.length || tiers.length > 6) throw bad('Add 1 to 6 reward tiers');
  if (new Set(tiers.map((t) => t.threshold)).size !== tiers.length) throw bad('Each tier needs a different target');
  tiers.sort((x, y) => x.threshold - y.threshold);
  return {
    name, description: String(b.description || '').trim().slice(0, 300) || null, type, period, business_id: biz.id,
    min_bill_paise: minBill, segment, branch_ids: branchIds, valid_from: b.valid_from, valid_to: b.valid_to,
    repeatable: b.repeatable === false || b.repeatable === 0 ? 0 : 1, active: b.active === false || b.active === 0 ? 0 : 1, tiers,
  };
}

const COLS = ['name', 'description', 'type', 'period', 'business_id', 'min_bill_paise', 'segment', 'branch_ids', 'valid_from', 'valid_to', 'repeatable', 'active'];

function saveTiers(id, tiers) {
  run('DELETE FROM challenge_tiers WHERE challenge_id = ?', id);
  for (const t of tiers) {
    run('INSERT INTO challenge_tiers(challenge_id, threshold, reward_type, reward_cp, reward_offer_id, reward_valid_days) VALUES (?,?,?,?,?,?)',
      id, t.threshold, t.reward.type, t.reward.cp, t.reward.offer_id, t.valid_days);
  }
}

export function createChallenge(body, staff, ip) {
  const c = normaliseChallenge(body);
  const id = tx(() => {
    const nid = Number(run(`INSERT INTO challenges(${COLS.join(', ')}, created_by, created_at) VALUES (${COLS.map(() => '?').join(',')},?,?)`,
      ...COLS.map((k) => c[k]), staff.id, nowIso()).lastInsertRowid);
    saveTiers(nid, c.tiers);
    return nid;
  });
  audit({ type: staff.role, id: staff.id, name: staff.name }, 'CHALLENGE_CREATED', 'challenge', id, c, ip);
  return id;
}

export function updateChallenge(id, body, staff, ip) {
  const cur = get('SELECT * FROM challenges WHERE id = ?', id);
  if (!cur) throw new HttpError(404, 'Challenge not found');
  if (body && Object.keys(body).length === 1 && 'active' in body) {
    run('UPDATE challenges SET active = ?, updated_by = ?, updated_at = ? WHERE id = ?', body.active ? 1 : 0, staff.id, nowIso(), cur.id);
    audit({ type: staff.role, id: staff.id, name: staff.name }, body.active ? 'CHALLENGE_ACTIVATED' : 'CHALLENGE_DEACTIVATED', 'challenge', cur.id, null, ip);
    return;
  }
  const c = normaliseChallenge(body);
  const awarded = get('SELECT 1 FROM challenge_awards WHERE challenge_id = ? LIMIT 1', cur.id);
  const oldTiers = tiersOf(cur.id).map((t) => `${t.threshold}|${t.reward_type}|${t.reward_cp}|${t.reward_offer_id}|${t.reward_valid_days}`).join(';');
  const newTiers = c.tiers.map((t) => `${t.threshold}|${t.reward.type}|${t.reward.cp}|${t.reward.offer_id}|${t.valid_days}`).join(';');
  if (awarded && (oldTiers !== newTiers || c.type !== cur.type || c.period !== cur.period)) {
    throw bad('Rewards have already been given for this challenge, so its type, period and tiers are locked. Deactivate it and create a new one.');
  }
  tx(() => {
    run(`UPDATE challenges SET ${COLS.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`, ...COLS.map((k) => c[k]), staff.id, nowIso(), cur.id);
    if (!awarded) saveTiers(cur.id, c.tiers);
  });
  audit({ type: staff.role, id: staff.id, name: staff.name }, 'CHALLENGE_UPDATED', 'challenge', cur.id, c, ip);
}

/** Admin list with performance: participants, tier completions, completion rate, rewards given. */
export function challengeList() {
  const today = istDate();
  const activeCustomers = get("SELECT COUNT(*) n FROM customers WHERE status = 'ACTIVE'").n;
  return all('SELECT * FROM challenges ORDER BY active DESC, id DESC').map((ch) => {
    const per = periodOf(ch, today < ch.valid_from ? ch.valid_from : today > ch.valid_to ? ch.valid_to : today);
    const eligibleN = ch.segment ? get('SELECT COUNT(*) n FROM customer_segments WHERE segment = ?', ch.segment).n : activeCustomers;
    const participants = get('SELECT COUNT(*) n FROM customer_challenge_progress WHERE challenge_id = ? AND period_key = ? AND progress > 0', ch.id, per.key).n;
    const participantsAll = get('SELECT COUNT(DISTINCT customer_id) n FROM customer_challenge_progress WHERE challenge_id = ? AND progress > 0', ch.id).n;
    const tiers = tiersOf(ch.id).map((t) => ({
      ...t,
      label: fmtThreshold(ch, t.threshold),
      reward: rewardLabel(t),
      awarded_now: get('SELECT COUNT(*) n FROM challenge_awards WHERE tier_id = ? AND period_key = ?', t.id, per.key).n,
      awarded_total: get('SELECT COUNT(*) n FROM challenge_awards WHERE tier_id = ?', t.id).n,
    }));
    const completersAll = get('SELECT COUNT(DISTINCT customer_id) n FROM challenge_awards WHERE challenge_id = ?', ch.id).n;
    const given = get("SELECT COALESCE(SUM(reward_cp),0) cp, SUM(CASE WHEN reward_type = 'OFFER' THEN 1 ELSE 0 END) offers FROM challenge_awards WHERE challenge_id = ?", ch.id);
    return {
      ...ch,
      type_label: CHALLENGE_TYPES[ch.type],
      period_label: PERIODS[ch.period],
      segment_label: ch.segment ? segmentLabel(ch.segment) : 'All customers',
      business_name: get('SELECT name FROM businesses WHERE id = ?', ch.business_id)?.name,
      current_period: per,
      eligible: eligibleN,
      participants,
      participants_all: participantsAll,
      completers_all: completersAll,
      completion_rate: participantsAll ? completersAll / participantsAll : 0,
      points_given_cp: given.cp,
      offers_unlocked: given.offers || 0,
      tiers,
    };
  });
}
