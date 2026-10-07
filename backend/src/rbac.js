import { HttpError } from './util.js';

/**
 * Role-based access. `staff.role` still says which panel a login opens (ADMIN = Admin Panel,
 * MANAGER = Manager Panel); `staff.access_role` says what it may do there, and
 * `staff.business_id` limits business-scoped roles to one business.
 */
export const ACCESS_ROLES = {
  SUPER_ADMIN: { label: 'Super Admin', panel: 'ADMIN', about: 'Entire ecosystem, including businesses, settlements, staff and settings' },
  VASANTHAM_ADMIN: { label: 'Vasantham Admin', panel: 'ADMIN', about: 'Vasantham operations: uploads, customers, offers, campaigns, engagement, redemptions, reports' },
  BUSINESS_ADMIN: { label: 'Business Owner / Admin', panel: 'ADMIN', business: 'required', about: 'Own business only: its offers, redemptions, settlements, growth report and profile' },
  REPORTING: { label: 'Reporting User', panel: 'ADMIN', business: 'optional', about: 'Read-only reports (optionally for one business)' },
  BRANCH_MANAGER: { label: 'Branch Manager', panel: 'MANAGER', branch: true, about: 'Own branch / outlet: scan, redeem, enrol customers, daily report' },
  REDEMPTION_MANAGER: { label: 'Redemption Manager', panel: 'MANAGER', branch: true, about: 'Redemption functions only: scan, approve, receipts, confirm bills' },
};

const VIEW_REPORTS = ['dashboard.view', 'analytics.view', 'growth.view', 'campaigns.view', 'redemptions.view', 'settlements.view', 'businesses.view',
  'offers.view', 'engagement.view', 'branches.view'];

const PERMS = {
  SUPER_ADMIN: ['*'],
  VASANTHAM_ADMIN: [...VIEW_REPORTS, 'customers.view', 'customers.edit', 'data.upload', 'offers.manage', 'campaigns.manage', 'redemptions.manage',
    'reconciliation.manage', 'engagement.manage', 'branches.manage', 'audit.view'],
  BUSINESS_ADMIN: ['growth.view', 'offers.view', 'offers.manage', 'redemptions.view', 'settlements.view', 'businesses.view', 'businesses.profile', 'branches.view'],
  REPORTING: VIEW_REPORTS,
  BRANCH_MANAGER: ['counter.redeem', 'counter.enrol', 'counter.report'],
  REDEMPTION_MANAGER: ['counter.redeem'],
};

export const accessRoleOf = (s) => s.access_role || (s.role === 'ADMIN' ? 'SUPER_ADMIN' : 'BRANCH_MANAGER');

export function permissionsOf(s) {
  return PERMS[accessRoleOf(s)] || [];
}
export const can = (s, perm) => {
  const p = permissionsOf(s);
  return p.includes('*') || p.includes(perm);
};

/** Business the login is limited to (null = all businesses). */
export function scopeOf(s) {
  const r = accessRoleOf(s);
  if (r === 'BUSINESS_ADMIN' || (r === 'REPORTING' && s.business_id)) return { businessId: s.business_id };
  return { businessId: null };
}

export function requirePerm(perm) {
  return (req, _res, next) => {
    if (!can(req.staff, perm)) throw new HttpError(403, 'Your role does not allow this');
    next();
  };
}

/**
 * Admin API guard table: longest matching path prefix wins.
 * [prefix, permission for GET, permission for other methods]
 */
const ADMIN_GUARDS = [
  ['/me', null, null],
  ['/dashboard', 'dashboard.view'],
  ['/liability', 'analytics.view'],
  ['/analytics', 'analytics.view'],
  ['/growth', 'growth.view'],
  ['/customers', 'customers.view', 'customers.edit'],
  ['/purchases', 'customers.view'],
  ['/ledger', 'customers.view'],
  ['/branches', 'branches.view', 'branches.manage'],
  ['/businesses/meta', 'businesses.view'],
  ['/businesses', 'businesses.view', 'businesses.manage|businesses.profile'], // profile-only edits are checked in the route
  ['/settlements', 'settlements.view', 'settlements.manage'],
  ['/challenges', 'engagement.view', 'engagement.manage'],
  ['/automations/preview', 'engagement.manage', 'engagement.manage'],
  ['/automations', 'engagement.view', 'engagement.manage'],
  ['/referrals', 'engagement.view', 'engagement.manage'],
  ['/interest-segments', 'engagement.view', 'engagement.manage'],
  ['/segments/options', 'offers.view|engagement.view'],
  ['/segments', 'customers.view|analytics.view', 'engagement.manage'],
  ['/contact', 'settings.manage', 'settings.manage'],
  ['/settings', 'settings.manage', 'settings.manage'],
  ['/staff', 'staff.manage', 'staff.manage'],
  ['/imports', 'data.upload', 'data.upload'],
  ['/offers', 'offers.view', 'offers.manage'],
  ['/campaigns', 'campaigns.view', 'campaigns.manage'],
  ['/redemptions', 'redemptions.view', 'redemptions.manage'],
  ['/reconciliation', 'redemptions.view', 'reconciliation.manage'],
  ['/audit', 'audit.view', 'audit.view'],
].sort((a, b) => b[0].length - a[0].length);

/** Vasantham-wide reports and tools: never available to business-limited logins. */
const UNSCOPED_ONLY = ['/dashboard', '/liability', '/analytics', '/campaigns', '/reconciliation', '/challenges', '/automations', '/referrals',
  '/interest-segments', '/segments', '/customers', '/ledger', '/purchases', '/imports', '/audit'];

export function adminGuard(req, _res, next) {
  const g = ADMIN_GUARDS.find(([prefix]) => req.path === prefix || req.path.startsWith(`${prefix}/`));
  if (!g) {
    if (can(req.staff, '*')) return next(); // unknown route: super admin only
    throw new HttpError(403, 'Your role does not allow this');
  }
  const need = req.method === 'GET' ? g[1] : g[2] ?? g[1];
  if (need && !need.split('|').some((p) => can(req.staff, p))) throw new HttpError(403, 'Your role does not allow this');
  req.scope = scopeOf(req.staff);
  if (req.scope.businessId && UNSCOPED_ONLY.some((p) => (req.path === p || req.path.startsWith(`${p}/`)) && !req.path.startsWith('/segments/options'))) {
    throw new HttpError(403, 'This report covers all of Vasantham and is not available to a single-business login');
  }
  next();
}

/** For scoped logins: throw unless the record belongs to their business. */
export function assertInScope(req, businessId) {
  const b = req.scope?.businessId;
  if (b && Number(businessId) !== Number(b)) throw new HttpError(403, 'This belongs to another business');
}
