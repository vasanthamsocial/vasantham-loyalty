import { get, run } from './db.js';
import { nowIso, istDate, fmtPoints } from './util.js';
import { setting } from './db.js';

/** actor: { type: 'ADMIN'|'MANAGER'|'CUSTOMER'|'SYSTEM', id, name, branch_id } */
export function audit(actor, action, entity, entityId, details, ip) {
  run(
    'INSERT INTO audit_logs(actor_type, actor_id, actor_name, branch_id, action, entity, entity_id, details, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    actor?.type || 'SYSTEM', actor?.id ?? null, actor?.name ?? null, actor?.branch_id ?? null,
    action, entity ?? null, entityId == null ? null : String(entityId),
    details ? JSON.stringify(details) : null, ip ?? null, nowIso(),
  );
}

export const staffActor = (s) => ({ type: s.role, id: s.id, name: s.name, branch_id: s.branch_id });
export const customerActor = (c) => ({ type: 'CUSTOMER', id: c.id, name: c.mobile });
export const SYSTEM = { type: 'SYSTEM', id: null, name: 'system' };

/**
 * In-app notification. Promotional kinds are rate-limited per customer per day
 * so the channel never turns into spam; transactional kinds always go through.
 */
const TRANSACTIONAL = new Set(['POINTS_EARNED', 'REDEMPTION', 'POINTS_ADJUSTED', 'POINTS_REVERSED', 'REWARD_UNLOCKED']);
export function notify(customerId, kind, title, body, offerId = null) {
  if (!TRANSACTIONAL.has(kind)) {
    const today = istDate();
    const n = get(
      "SELECT COUNT(*) n FROM notifications WHERE customer_id = ? AND date(created_at, '+330 minutes') = ? AND kind NOT IN ('POINTS_EARNED','REDEMPTION','POINTS_ADJUSTED','POINTS_REVERSED','REWARD_UNLOCKED')",
      customerId, today,
    ).n;
    if (n >= setting('notif_daily_cap')) return false;
  }
  run('INSERT INTO notifications(customer_id, kind, title, body, offer_id, created_at) VALUES (?,?,?,?,?,?)', customerId, kind, title, body, offerId, nowIso());
  return true;
}

export { fmtPoints };
