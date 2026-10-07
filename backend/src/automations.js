import { all, get, run, tx } from './db.js';
import { audit } from './audit.js';
import { assertGrantableOffer, grantReward } from './rewards.js';
import { customersInSegment, segmentLabel } from './segments.js';
import { HttpError, addDays, bad, istDate, nowIso } from './util.js';

/**
 * Reactivation automations: "customers who enter segment X get reward Y".
 * Runs after every Excel upload (once segments are refreshed), nightly, and on demand.
 * A customer is targeted again by the same automation only after the cooldown.
 * Recovery = the customer bought something (any Vasantham bill) within the window after being targeted.
 */
const DONE = "('APPROVED','SUBMITTED','BILLED','RECONCILED')";

export function normaliseAutomation(b = {}) {
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) throw bad('Automation name is required');
  const segment = String(b.segment || '').trim();
  if (!segment || segment === 'ALL') throw bad('Choose the customer segment to target');
  const offer = assertGrantableOffer(b.offer_id, 'Reward');
  const int = (v, lo, hi, label, dflt) => {
    const n = v === '' || v == null ? dflt : parseInt(v, 10);
    if (!(n >= lo && n <= hi)) throw bad(`${label} must be ${lo}–${hi} days`);
    return n;
  };
  return {
    name,
    segment,
    offer_id: offer.id,
    reward_valid_days: int(b.reward_valid_days, 1, 365, 'Reward validity', 14),
    cooldown_days: int(b.cooldown_days, 7, 365, 'Cooldown', 60),
    window_days: int(b.window_days, 1, 180, 'Recovery window', 30),
    message: String(b.message || '').trim().slice(0, 200) || null,
    active: b.active === true || b.active === 1 || b.active === '1' ? 1 : 0,
  };
}

const COLS = ['name', 'segment', 'offer_id', 'reward_valid_days', 'cooldown_days', 'window_days', 'message', 'active'];

export function saveAutomation(id, body, staff, ip) {
  const a = normaliseAutomation(body);
  if (id) {
    if (!get('SELECT 1 FROM automations WHERE id = ?', id)) throw new HttpError(404, 'Automation not found');
    run(`UPDATE automations SET ${COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...COLS.map((k) => a[k]), nowIso(), id);
  } else {
    id = Number(run(`INSERT INTO automations(${COLS.join(', ')}, created_by, created_at) VALUES (${COLS.map(() => '?').join(',')},?,?)`,
      ...COLS.map((k) => a[k]), staff.id, nowIso()).lastInsertRowid);
  }
  audit({ type: staff.role, id: staff.id, name: staff.name }, 'AUTOMATION_SAVED', 'automation', id, a, ip);
  return id;
}

/** Customers who would be targeted now (in the segment, not within the cooldown). */
function candidates(a, today) {
  const since = addDays(today, -a.cooldown_days);
  const recent = new Set(all('SELECT customer_id FROM automation_targets WHERE automation_id = ? AND target_date > ?', a.id, since).map((r) => r.customer_id));
  return customersInSegment(a.segment).filter((id) => !recent.has(id));
}

export function previewAutomation(body) {
  const a = { ...normaliseAutomation(body), id: Number(body?.id) || 0 };
  return { would_target: candidates(a, istDate()).length, segment_size: customersInSegment(a.segment).length };
}

/** Run one automation (or all active ones). Returns how many customers were targeted. */
export function runAutomations({ id = null, staff = null, ip = null } = {}) {
  const today = istDate();
  const list = id ? all('SELECT * FROM automations WHERE id = ?', id) : all('SELECT * FROM automations WHERE active = 1');
  if (id && !list.length) throw new HttpError(404, 'Automation not found');
  const out = [];
  for (const a of list) {
    const offer = get('SELECT * FROM offers WHERE id = ?', a.offer_id);
    let n = 0;
    if (offer?.active && offer.valid_to >= today) {
      for (const cid of candidates(a, today)) {
        tx(() => {
          const given = grantReward(cid, { type: 'OFFER', offer_id: a.offer_id }, {
            source: 'AUTOMATION', title: a.message || 'We miss you!', note: a.message || 'A special reward for your next visit', validDays: a.reward_valid_days,
          });
          if (!given) return;
          run('INSERT OR IGNORE INTO automation_targets(automation_id, customer_id, target_date, targeted_at) VALUES (?,?,?,?)', a.id, cid, today, nowIso());
          n++;
        });
      }
    }
    run('UPDATE automations SET last_run_at = ? WHERE id = ?', nowIso(), a.id);
    if (n || staff) audit(staff ? { type: staff.role, id: staff.id, name: staff.name } : { type: 'SYSTEM' }, 'AUTOMATION_RUN', 'automation', a.id, { targeted: n }, ip);
    out.push({ id: a.id, name: a.name, targeted: n });
  }
  return out;
}

/** Performance: targeted, recovered within the window, revenue after targeting, reward redemptions. */
export function automationReport() {
  return all(
    `SELECT a.*, o.title offer_title, o.value_paise offer_value_paise, b.name business_name
       FROM automations a JOIN offers o ON o.id = a.offer_id JOIN businesses b ON b.id = o.business_id ORDER BY a.active DESC, a.id DESC`,
  ).map((a) => {
    const m = get(
      `SELECT COUNT(*) targeted,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM purchases p WHERE p.customer_id = t.customer_id AND p.bill_type = 'SALE'
                   AND p.bill_date >= t.target_date AND p.bill_date <= date(t.target_date, '+' || ? || ' days')) THEN 1 ELSE 0 END) recovered,
              COALESCE(SUM((SELECT SUM(p.net_paise) FROM purchases p WHERE p.customer_id = t.customer_id AND p.bill_type = 'SALE'
                   AND p.bill_date >= t.target_date AND p.bill_date <= date(t.target_date, '+' || ? || ' days'))), 0) revenue_paise,
              SUM(CASE WHEN date(t.target_date, '+' || ? || ' days') >= ? THEN 1 ELSE 0 END) in_window
         FROM automation_targets t WHERE t.automation_id = ?`,
      a.window_days, a.window_days, a.window_days, istDate(), a.id,
    );
    const red = get(
      `SELECT COUNT(*) n, COALESCE(SUM(r.value_paise),0) value, COALESCE(SUM(CASE WHEN r.reward_cost_paise > 0 THEN r.reward_cost_paise ELSE r.value_paise END),0) cost
         FROM redemptions r
        WHERE r.offer_id = ? AND r.status IN ${DONE}
          AND EXISTS (SELECT 1 FROM automation_targets t WHERE t.automation_id = ? AND t.customer_id = r.customer_id
                        AND t.target_date <= date(r.approved_at, '+330 minutes'))`,
      a.offer_id, a.id,
    );
    return {
      ...a,
      segment_label: segmentLabel(a.segment),
      targeted: m.targeted,
      recovered: m.recovered || 0,
      recovery_rate: m.targeted ? (m.recovered || 0) / m.targeted : 0,
      still_in_window: m.in_window || 0,
      revenue_paise: m.revenue_paise,
      redemptions: red.n,
      reward_cost_paise: red.cost,
      would_target_now: candidates(a, istDate()).length,
    };
  });
}
