import { all, get, run, setting, tx } from './db.js';
import { audit } from './audit.js';
import { HttpError, addDays, bad, istDate, nowIso } from './util.js';

export const ISSUE_TYPES = {
  MISSING_BILL: 'Missing billing entry',
  WRONG_AMOUNT: 'Wrong amount',
  DUPLICATE_REDEMPTION: 'Duplicate redemption',
  CANCELLED_BILL: 'Cancelled bill',
  UNMATCHED_ID: 'Unmatched redemption ID',
  INACTIVE_REDEMPTION: 'Bill uses a cancelled / reversed redemption',
  NOT_APPROVED: 'Bill uses a redemption that was never approved',
  CUSTOMER_MISMATCH: 'Bill customer differs from redemption customer',
};

export const REF_PATTERN = /VR-\d{6}-\d{4,}/gi;
export const extractRefs = (s) => [...new Set((String(s || '').match(REF_PATTERN) || []).map((x) => x.toUpperCase()))];

function issue(type, { redemption, purchase, ref, expected = null, actual = null, detail = null, importId = null }) {
  run(
    `INSERT INTO recon_issues(type, redemption_id, purchase_id, branch_id, ref_text, expected_paise, actual_paise, detail, import_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    type, redemption?.id ?? null, purchase?.id ?? null, purchase?.branch_id ?? redemption?.branch_id ?? null,
    ref ?? null, expected, actual, detail, importId, nowIso(),
  );
}

function setStatus(r, to, fields = {}) {
  const sets = ['status = ?', ...Object.keys(fields).map((k) => `${k} = ?`)];
  run(`UPDATE redemptions SET ${sets.join(', ')} WHERE id = ?`, to, ...Object.values(fields), r.id);
  run(
    'INSERT INTO redemption_events(redemption_id, from_status, to_status, actor_type, branch_id, note, created_at) VALUES (?,?,?,?,?,?,?)',
    r.id, r.status, to, 'SYSTEM', r.branch_id, fields.recon_status || 'Excel reconciliation', nowIso(),
  );
}

/**
 * Compare the manager-approved redemptions referenced on a bill with what
 * billing actually recorded. Called by the importer inside its transaction.
 */
export function reconcileBill(p, refs, importId) {
  const out = { reconciled: 0, issues: 0 };
  const flag = (type, o) => { issue(type, { purchase: p, importId, ...o }); out.issues++; };

  if (p.bill_type === 'CANCELLED') {
    // Any redemption tied to the original bill (or referenced here) was used on a bill that no longer exists.
    const linked = p.original_purchase_id ? all('SELECT * FROM redemptions WHERE purchase_id = ?', p.original_purchase_id) : [];
    const ids = new Set([...linked.map((r) => r.id), ...refs]);
    for (const id of ids) {
      const r = get('SELECT * FROM redemptions WHERE id = ?', id);
      flag('CANCELLED_BILL', { redemption: r, ref: id, expected: r?.value_paise ?? null, detail: `Bill ${p.bill_no} was cancelled after redemption ${id} was applied. Review whether points/offer should be restored.` });
    }
    return out;
  }
  if (!refs.length || p.bill_type !== 'SALE') return out;

  const valid = [];
  for (const ref of refs) {
    const r = get('SELECT * FROM redemptions WHERE id = ?', ref);
    if (!r) flag('UNMATCHED_ID', { ref, detail: `Bill ${p.bill_no} references ${ref}, which does not exist` });
    else if (['CANCELLED', 'REVERSED', 'EXPIRED'].includes(r.status)) flag('INACTIVE_REDEMPTION', { redemption: r, ref, expected: r.value_paise, detail: `${ref} is ${r.status.toLowerCase()} but was applied on bill ${p.bill_no}` });
    else if (r.status === 'CREATED') flag('NOT_APPROVED', { redemption: r, ref, expected: r.value_paise, detail: `${ref} was never approved by a manager` });
    else if (r.purchase_id && r.purchase_id !== p.id) {
      const other = get('SELECT bill_no, bill_date FROM purchases WHERE id = ?', r.purchase_id);
      flag('DUPLICATE_REDEMPTION', { redemption: r, ref, expected: r.value_paise, detail: `${ref} already used on bill ${other?.bill_no} (${other?.bill_date})` });
    } else valid.push(r);
  }
  if (!valid.length) return out;

  const now = nowIso();
  for (const r of valid) {
    if (p.customer_id && r.customer_id !== p.customer_id) {
      flag('CUSTOMER_MISMATCH', { redemption: r, ref: r.id, expected: r.value_paise, detail: `Bill ${p.bill_no} customer does not match the redemption customer` });
    }
    setStatus(r, 'BILLED', { billed_at: now, purchase_id: p.id });
    r.status = 'BILLED';
  }
  const expected = valid.reduce((s, r) => s + r.value_paise, 0);
  const actual = p.loyalty_discount_paise;
  if (actual === null || actual === undefined) {
    for (const r of valid) run("UPDATE redemptions SET recon_status = 'AMOUNT_NOT_ON_BILL' WHERE id = ?", r.id);
    flag('WRONG_AMOUNT', { redemption: valid[0], ref: valid.map((r) => r.id).join(', '), expected, actual: null, detail: `Loyalty discount amount missing on bill ${p.bill_no}` });
  } else if (actual !== expected) {
    for (const r of valid) run("UPDATE redemptions SET recon_status = 'AMOUNT_MISMATCH' WHERE id = ?", r.id);
    flag('WRONG_AMOUNT', { redemption: valid[0], ref: valid.map((r) => r.id).join(', '), expected, actual, detail: `Bill ${p.bill_no}: approved ₹${expected / 100}, billed ₹${actual / 100}` });
  } else {
    for (const r of valid) {
      setStatus(r, 'RECONCILED', { reconciled_at: now, recon_status: 'MATCHED' });
      out.reconciled++;
    }
  }
  return out;
}

/** Approved redemptions whose branch has uploaded bills past the grace period but no matching bill. */
export function missingBills(branchId = null) {
  const grace = setting('missing_bill_grace_days');
  const rows = all(
    `SELECT r.*, c.mobile, c.name customer_name, b.name branch_name, s.name approved_by_name,
            (SELECT MAX(bill_date) FROM purchases p WHERE p.branch_id = r.branch_id) last_bill_date
       FROM redemptions r
       JOIN customers c ON c.id = r.customer_id
       JOIN branches b ON b.id = r.branch_id
       LEFT JOIN staff s ON s.id = r.approved_by
      WHERE r.status IN ('APPROVED','SUBMITTED') AND (? IS NULL OR r.branch_id = ?)
      ORDER BY r.approved_at`,
    branchId, branchId,
  );
  return rows.filter((r) => r.last_bill_date && addDays(istDate(r.approved_at), grace) <= r.last_bill_date);
}

export function reconciliationReport({ status = 'OPEN', branchId = null } = {}) {
  const issues = all(
    `SELECT i.*, b.name branch_name, p.bill_no, p.bill_date
       FROM recon_issues i
       LEFT JOIN branches b ON b.id = i.branch_id
       LEFT JOIN purchases p ON p.id = i.purchase_id
      WHERE (? = 'ALL' OR (? = 'OPEN' AND i.resolved_at IS NULL) OR (? = 'RESOLVED' AND i.resolved_at IS NOT NULL))
        AND (? IS NULL OR i.branch_id = ?)
      ORDER BY i.id DESC LIMIT 500`,
    status, status, status, branchId, branchId,
  ).map((i) => ({ ...i, type_label: ISSUE_TYPES[i.type] || i.type }));
  const missing = status === 'RESOLVED' ? [] : missingBills(branchId);
  const counts = {};
  for (const i of issues) if (!i.resolved_at) counts[i.type] = (counts[i.type] || 0) + 1;
  counts.MISSING_BILL = missing.length;
  const summary = get(
    `SELECT
       SUM(CASE WHEN status = 'RECONCILED' THEN 1 ELSE 0 END) reconciled,
       SUM(CASE WHEN status IN ('APPROVED','SUBMITTED') THEN 1 ELSE 0 END) pending,
       SUM(CASE WHEN status = 'BILLED' THEN 1 ELSE 0 END) billed_unmatched
     FROM redemptions WHERE (? IS NULL OR branch_id = ?)`,
    branchId, branchId,
  );
  return { issues, missing, counts, summary, labels: ISSUE_TYPES };
}

export function resolveIssue(id, staff, note, markReconciled, ip) {
  note = String(note || '').trim();
  if (!note) throw bad('A resolution note is required');
  return tx(() => {
    const i = get('SELECT * FROM recon_issues WHERE id = ?', id);
    if (!i) throw new HttpError(404, 'Issue not found');
    if (i.resolved_at) throw bad('Already resolved');
    run('UPDATE recon_issues SET resolved_at = ?, resolved_by = ?, resolution_note = ? WHERE id = ?', nowIso(), staff.id, note, id);
    if (markReconciled && i.redemption_id) forceReconcile(i.redemption_id, staff, note);
    audit({ type: staff.role, id: staff.id, name: staff.name }, 'RECON_ISSUE_RESOLVED', 'recon_issue', id, { note, markReconciled: !!markReconciled }, ip);
  });
}

/** Admin manually confirms a redemption as billed correctly (e.g. verified from paper bill). */
export function forceReconcile(redemptionId, staff, note) {
  const r = get('SELECT * FROM redemptions WHERE id = ?', redemptionId);
  if (!r) throw new HttpError(404, 'Redemption not found');
  if (!['APPROVED', 'SUBMITTED', 'BILLED'].includes(r.status)) throw bad(`Cannot reconcile a ${r.status.toLowerCase()} redemption`);
  const now = nowIso();
  run("UPDATE redemptions SET status = 'RECONCILED', reconciled_at = ?, recon_status = 'MANUAL' WHERE id = ?", now, r.id);
  run(
    'INSERT INTO redemption_events(redemption_id, from_status, to_status, actor_type, actor_id, note, created_at) VALUES (?,?,?,?,?,?,?)',
    r.id, r.status, 'RECONCILED', staff.role, staff.id, `Manual reconciliation: ${note}`, now,
  );
}
