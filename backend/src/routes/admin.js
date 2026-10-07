import express, { Router } from 'express';
import { all, allSettings, get, run, tx } from '../db.js';
import { DEFAULT_SETTINGS } from '../config.js';
import { hashPassword, requireStaff } from '../auth.js';
import { customerCard, savings } from '../customers.js';
import { OFFER_TYPES, normaliseOffer, offerConditions, offersForCustomer } from '../offers.js';
import { postLedger } from '../points.js';
import { cancelOrReverse, CANCEL_REASONS, receipt } from '../redemptions.js';
import { importWorkbook, templateWorkbook, TEMPLATE_HEADERS, FIELDS } from '../importer.js';
import { reconciliationReport, resolveIssue, forceReconcile } from '../reconcile.js';
import { SEGMENTS, customersInSegment, recomputeSegments, segmentCounts, segmentLabel } from '../segments.js';
import { branchAnalytics, campaignReport, customerAnalytics, customerInsights, dashboard, liability } from '../analytics.js';
import { audit, notify, staffActor } from '../audit.js';
import { branchContactFields, careInfo, saveCareInfo } from '../contact.js';
import { attachmentView, logoUrl, removeLogo, removeOfferAttachment, saveLogo, saveOfferAttachment } from '../media.js';
import { BILLING_SOURCES, LIMIT_TYPES, SETTLEMENT_CYCLES, businessView, getBusiness, normaliseBusiness, normaliseRule, ruleLines, ruleOf } from '../businesses.js';
import { FUNDING_TYPES } from '../offers.js';
import { CHALLENGE_TYPES, PERIODS, challengeList, createChallenge, updateChallenge } from '../challenges.js';
import { automationReport, previewAutomation, runAutomations, saveAutomation } from '../automations.js';
import { referralReport, rejectReferral, saveProgram } from '../referrals.js';
import { ACCESS_ROLES, accessRoleOf, adminGuard, assertInScope, can } from '../rbac.js';
import { growthDashboard, rebuildActivity } from '../growth.js';
import { createSettlement, listSettlements, markSettled, openTransactions, settlementDetail, settlementReport, voidSettlement } from '../settlement.js';
import { HttpError, addDays, bad, fmtPoints, isDate, istDate, maskMobile, normMobile, nowIso, parsePointsInput, toPaise } from '../util.js';

const r = Router();
r.use(requireStaff('ADMIN'));
r.use(adminGuard); // role permissions per route; sets req.scope for business-limited logins
const A = (req) => staffActor(req.staff);
/** Business filter for a request: forced to the login's own business when it is business-limited. */
const scopeBiz = (req, requested) => req.scope?.businessId ?? (requested ? Number(requested) : null);
const page = (req) => {
  const size = Math.min(200, Math.max(1, parseInt(req.query.size || 50, 10)));
  const p = Math.max(1, parseInt(req.query.page || 1, 10));
  return { size, offset: (p - 1) * size, page: p };
};

r.get('/me', (req, res) => {
  const s = req.staff;
  res.json({
    id: s.id, name: s.name, username: s.username, role: s.role, access_role: s.access_role, access_label: ACCESS_ROLES[s.access_role]?.label,
    permissions: s.permissions, business_id: req.scope.businessId,
    business_name: req.scope.businessId ? get('SELECT name FROM businesses WHERE id = ?', req.scope.businessId)?.name : null,
  });
});

/* ---------- ecosystem growth dashboard ---------- */
r.get('/growth', (req, res) => {
  const to = isDate(req.query.to) ? req.query.to : istDate();
  const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
  res.json(growthDashboard({ from, to, businessId: scopeBiz(req, req.query.business) }));
});

/* ---------- dashboard ---------- */
r.get('/dashboard', (req, res) => res.json(dashboard()));
r.get('/liability', (req, res) => res.json(liability()));

/* ---------- customers ---------- */
r.get('/customers', (req, res) => {
  const { size, offset, page: p } = page(req);
  const q = String(req.query.q || '').trim();
  const seg = String(req.query.segment || '');
  const where = [];
  const params = [];
  if (q) {
    where.push('(c.mobile LIKE ? OR c.name LIKE ? OR c.code = ? OR c.pos_customer_code = ?)');
    params.push(`%${q}%`, `%${q}%`, q.toUpperCase(), q);
  }
  if (seg) {
    where.push('c.id IN (SELECT customer_id FROM customer_segments WHERE segment = ?)');
    params.push(seg);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) n FROM customers c ${w}`, ...params).n;
  const rows = all(
    `SELECT c.id, c.code, c.mobile, c.name, c.balance_cp, c.last_purchase_date, c.enrolled_via, c.enrolled_at, c.app_registered_at, c.status, b.name home_branch,
            (SELECT GROUP_CONCAT(segment) FROM customer_segments s WHERE s.customer_id = c.id) segments
       FROM customers c LEFT JOIN branches b ON b.id = c.home_branch_id ${w}
      ORDER BY c.last_purchase_date DESC NULLS LAST, c.id DESC LIMIT ? OFFSET ?`,
    ...params, size, offset,
  );
  res.json({ total, page: p, size, rows });
});

r.get('/customers/:id', (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found');
  res.json({
    customer: { ...customerCard(c), enrolled_via: c.enrolled_via, enrolled_at: c.enrolled_at, app_registered_at: c.app_registered_at, pos_customer_code: c.pos_customer_code,
      home_branch: get('SELECT name FROM branches WHERE id = ?', c.home_branch_id)?.name },
    segments: all('SELECT segment FROM customer_segments WHERE customer_id = ?', c.id).map((s) => ({ segment: s.segment, label: segmentLabel(s.segment) })),
    insights: customerInsights(c.id),
    savings: savings(c.id),
    offers: offersForCustomer(c),
    ledger: all(`SELECT l.*, b.name branch, p.bill_date FROM points_ledger l LEFT JOIN branches b ON b.id = l.branch_id LEFT JOIN purchases p ON p.id = l.purchase_id WHERE l.customer_id = ? ORDER BY l.id DESC LIMIT 200`, c.id),
    purchases: all(`SELECT p.*, b.name branch FROM purchases p JOIN branches b ON b.id = p.branch_id WHERE p.customer_id = ? ORDER BY p.bill_date DESC LIMIT 200`, c.id),
    redemptions: all(`SELECT r.*, b.name branch, s.name approved_by_name, o.title offer_title FROM redemptions r LEFT JOIN branches b ON b.id = r.branch_id
                        LEFT JOIN staff s ON s.id = r.approved_by LEFT JOIN offers o ON o.id = r.offer_id WHERE r.customer_id = ? ORDER BY r.created_at DESC LIMIT 100`, c.id),
  });
});

r.get('/purchases/:id', (req, res) => {
  const p = get('SELECT p.*, b.name branch FROM purchases p JOIN branches b ON b.id = p.branch_id WHERE p.id = ?', req.params.id);
  if (!p) throw new HttpError(404, 'Bill not found');
  res.json({ ...p, items: all('SELECT * FROM purchase_items WHERE purchase_id = ?', p.id) });
});

r.put('/customers/:id', (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found');
  const b = req.body || {};
  const name = b.name === undefined ? c.name : String(b.name).trim() || null;
  const dob = b.dob === undefined ? c.dob : b.dob || null;
  if (dob && !isDate(dob)) throw bad('Invalid date of birth');
  const anniversary = b.anniversary === undefined ? c.anniversary : b.anniversary || null;
  if (anniversary && !isDate(anniversary)) throw bad('Invalid anniversary date');
  const status = b.status === 'BLOCKED' ? 'BLOCKED' : 'ACTIVE';
  let mobile = c.mobile;
  if (b.mobile && b.mobile !== c.mobile) {
    mobile = normMobile(b.mobile);
    if (!mobile) throw bad('Invalid mobile number');
    if (get('SELECT 1 FROM customers WHERE mobile = ? AND id <> ?', mobile, c.id)) throw bad('Another customer already uses this mobile');
  }
  run('UPDATE customers SET name = ?, dob = ?, anniversary = ?, status = ?, mobile = ? WHERE id = ?', name, dob, anniversary, status, mobile, c.id);
  audit(A(req), 'CUSTOMER_UPDATED', 'customer', c.id, {
    before: { name: c.name, dob: c.dob, anniversary: c.anniversary, status: c.status, mobile: c.mobile },
    after: { name, dob, anniversary, status, mobile },
  }, req.ip);
  res.json({ ok: true });
});

/** Manual adjustment: signed points with a mandatory reason. */
r.post('/customers/:id/adjust', (req, res) => {
  const raw = String(req.body?.points ?? '').trim();
  const neg = raw.startsWith('-');
  const cp = parsePointsInput(neg ? raw.slice(1) : raw.replace(/^\+/, '')) * (neg ? -1 : 1);
  const reason = String(req.body?.reason || '').trim();
  if (!cp) throw bad('Enter points to add (e.g. 10) or deduct (e.g. -10)');
  if (!reason) throw bad('A reason is required for manual adjustments');
  const bal = tx(() => {
    const c = get('SELECT * FROM customers WHERE id = ?', req.params.id);
    if (!c) throw new HttpError(404, 'Customer not found');
    const nb = postLedger({ customerId: c.id, type: 'ADJUST', cp, note: reason, actor: A(req) });
    audit(A(req), 'POINTS_ADJUSTED', 'customer', c.id, { cp, reason, balance_after_cp: nb }, req.ip);
    notify(c.id, 'POINTS_ADJUSTED', cp > 0 ? `+${fmtPoints(cp)} points added` : `${fmtPoints(cp)} points adjusted`, reason);
    return nb;
  });
  res.json({ balance_cp: bal });
});

/* ---------- branches & staff ---------- */
r.get('/branches', (req, res) => res.json(all(
  `SELECT b.*, bz.name business_name, bz.code business_code, (SELECT COUNT(*) FROM staff s WHERE s.branch_id = b.id AND s.active = 1) managers,
          (SELECT MAX(bill_date) FROM purchases p WHERE p.branch_id = b.id) last_bill_date
     FROM branches b LEFT JOIN businesses bz ON bz.id = b.business_id WHERE (? IS NULL OR b.business_id = ?)
    ORDER BY bz.is_program_owner DESC, bz.name, b.name`,
  scopeBiz(req), scopeBiz(req),
)));

r.post('/branches', (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const name = String(req.body?.name || '').trim();
  if (!/^[A-Z0-9_-]{2,12}$/.test(code)) throw bad('Branch code: 2–12 letters/digits (as it appears in the POS export)');
  if (!name) throw bad('Branch name is required');
  if (get('SELECT 1 FROM branches WHERE code = ?', code)) throw bad('Branch code already exists');
  const c = branchContactFields(req.body);
  const biz = req.body?.business_id ? getBusiness(Number(req.body.business_id)) : get('SELECT * FROM businesses WHERE is_program_owner = 1 ORDER BY id LIMIT 1');
  if (!biz) throw bad('Choose the business this branch / outlet belongs to');
  const id = run('INSERT INTO branches(code, name, city, address, phone, whatsapp, map_url, business_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    code, name, String(req.body?.city || '').trim() || null, c.address ?? null, c.phone ?? null, c.whatsapp ?? null, c.map_url ?? null, biz.id, nowIso()).lastInsertRowid;
  audit(A(req), 'BRANCH_CREATED', 'branch', id, { code, name, business: biz.code, ...c }, req.ip);
  res.json({ id: Number(id) });
});

r.put('/branches/:id', (req, res) => {
  const b = get('SELECT * FROM branches WHERE id = ?', req.params.id);
  if (!b) throw new HttpError(404, 'Branch not found');
  const name = String(req.body?.name ?? b.name).trim();
  const city = req.body?.city === undefined ? b.city : String(req.body.city).trim() || null;
  const active = req.body?.active === undefined ? b.active : req.body.active ? 1 : 0;
  const c = { address: b.address, phone: b.phone, whatsapp: b.whatsapp, map_url: b.map_url, ...branchContactFields(req.body) };
  if (!name) throw bad('Branch name is required');
  let businessId = b.business_id;
  if (req.body?.business_id !== undefined && Number(req.body.business_id) !== b.business_id) {
    if (!getBusiness(Number(req.body.business_id))) throw bad('Business not found');
    if (get('SELECT 1 FROM purchases WHERE branch_id = ? UNION SELECT 1 FROM redemptions WHERE branch_id = ? LIMIT 1', b.id, b.id)) {
      throw bad('This branch already has bills or redemptions, so it cannot move to another business. Create a new branch instead.');
    }
    businessId = Number(req.body.business_id);
  }
  run('UPDATE branches SET name = ?, city = ?, active = ?, address = ?, phone = ?, whatsapp = ?, map_url = ?, business_id = ? WHERE id = ?',
    name, city, active, c.address, c.phone, c.whatsapp, c.map_url, businessId, b.id);
  audit(A(req), 'BRANCH_UPDATED', 'branch', b.id, { name, city, active, business_id: businessId, ...c }, req.ip);
  res.json({ ok: true });
});

/* ---------- businesses / partners ---------- */
const BIZ_COLS = ['name', 'category', 'tagline', 'active', 'can_earn', 'can_redeem', 'billing_source', 'offer_participation', 'settlement_cycle',
  'settlement_details', 'contact_person', 'contact_phone', 'contact_email', 'address', 'terms', 'notes', 'sort_order'];

function businessAdminView(b) {
  const rule = ruleOf(b.id);
  const stats = get(
    `SELECT COUNT(*) redemptions, COALESCE(SUM(value_paise),0) value_paise, COUNT(DISTINCT customer_id) customers
       FROM redemptions WHERE business_id = ? AND status IN ('APPROVED','SUBMITTED','BILLED','RECONCILED')`,
    b.id,
  );
  return {
    ...b,
    logo_url: logoUrl(b.logo_file),
    rule: { ...rule, lines: ruleLines(rule) },
    outlets: all('SELECT id, code, name, active FROM branches WHERE business_id = ? ORDER BY name', b.id),
    live_offers: get("SELECT COUNT(*) n FROM offers WHERE business_id = ? AND active = 1 AND valid_to >= date('now','+330 minutes')", b.id).n,
    stats,
  };
}

r.get('/businesses/meta', (req, res) => res.json({ limitTypes: LIMIT_TYPES, billingSources: BILLING_SOURCES, settlementCycles: SETTLEMENT_CYCLES, fundingTypes: FUNDING_TYPES }));
r.get('/businesses', (req, res) => res.json(
  all('SELECT * FROM businesses WHERE (? IS NULL OR id = ?) ORDER BY is_program_owner DESC, sort_order, name', scopeBiz(req), scopeBiz(req)).map(businessAdminView),
));
r.get('/businesses/:id', (req, res) => {
  const b = getBusiness(req.params.id);
  if (!b) throw new HttpError(404, 'Business not found');
  assertInScope(req, b.id);
  res.json(businessAdminView(b));
});
/** Business owners may edit their own public profile, but not permissions, rules or settlement terms. */
const PROFILE_FIELDS = ['tagline', 'contact_person', 'contact_phone', 'contact_email', 'address', 'terms'];
function requireBusinessManage(req, businessId) {
  if (can(req.staff, 'businesses.manage')) return;
  assertInScope(req, businessId);
  if (!can(req.staff, 'businesses.profile')) throw new HttpError(403, 'Your role does not allow this');
}

r.post('/businesses', (req, res) => {
  if (!can(req.staff, 'businesses.manage')) throw new HttpError(403, 'Your role does not allow this');
  const b = normaliseBusiness(req.body || {});
  if (get('SELECT 1 FROM businesses WHERE code = ?', b.code)) throw bad('Business code already exists');
  const rule = req.body?.rule ? normaliseRule(req.body.rule, 0) : null; // new business has no outlets yet
  const id = tx(() => {
    const cols = ['code', ...BIZ_COLS, 'created_by', 'created_at'];
    const nid = Number(run(`INSERT INTO businesses(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`,
      b.code, ...BIZ_COLS.map((k) => b[k]), req.staff.id, nowIso()).lastInsertRowid);
    const rr = rule || normaliseRule({}, nid);
    run(`INSERT INTO business_redemption_rules(business_id, limit_type, max_percent, max_value_paise, min_bill_paise, min_points_cp, branch_ids, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`, nid, rr.limit_type, rr.max_percent, rr.max_value_paise, rr.min_bill_paise, rr.min_points_cp, null, req.staff.id, nowIso());
    return nid;
  });
  audit(A(req), 'BUSINESS_CREATED', 'business', id, { ...b, rule }, req.ip);
  res.json(businessAdminView(getBusiness(id)));
});

r.put('/businesses/:id', (req, res) => {
  const cur = getBusiness(req.params.id);
  if (!cur) throw new HttpError(404, 'Business not found');
  requireBusinessManage(req, cur.id);
  const full = can(req.staff, 'businesses.manage');
  const body = full ? req.body || {} : Object.fromEntries(PROFILE_FIELDS.filter((k) => k in (req.body || {})).map((k) => [k, req.body[k]]));
  const b = normaliseBusiness(body, cur);
  const rule = full && req.body?.rule ? normaliseRule(req.body.rule, cur.id) : null;
  tx(() => {
    run(`UPDATE businesses SET ${BIZ_COLS.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`,
      ...BIZ_COLS.map((k) => b[k]), req.staff.id, nowIso(), cur.id);
    if (rule) saveRule(cur.id, rule, req.staff.id);
  });
  const changed = Object.fromEntries(BIZ_COLS.filter((k) => String(b[k] ?? '') !== String(cur[k] ?? '')).map((k) => [k, { from: cur[k], to: b[k] }]));
  audit(A(req), 'BUSINESS_UPDATED', 'business', cur.id, { changed, rule }, req.ip);
  res.json(businessAdminView(getBusiness(cur.id)));
});

function saveRule(businessId, rr, staffId) {
  run(`INSERT INTO business_redemption_rules(business_id, limit_type, max_percent, max_value_paise, min_bill_paise, min_points_cp, branch_ids, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(business_id) DO UPDATE SET limit_type = excluded.limit_type, max_percent = excluded.max_percent, max_value_paise = excluded.max_value_paise,
         min_bill_paise = excluded.min_bill_paise, min_points_cp = excluded.min_points_cp, branch_ids = excluded.branch_ids,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  businessId, rr.limit_type, rr.max_percent, rr.max_value_paise, rr.min_bill_paise, rr.min_points_cp, rr.branch_ids, staffId, nowIso());
}

r.put('/businesses/:id/rule', (req, res) => {
  if (!can(req.staff, 'businesses.manage')) throw new HttpError(403, 'Your role does not allow this');
  const cur = getBusiness(req.params.id);
  if (!cur) throw new HttpError(404, 'Business not found');
  const before = ruleOf(cur.id);
  const rule = normaliseRule(req.body || {}, cur.id);
  saveRule(cur.id, rule, req.staff.id);
  audit(A(req), 'REDEMPTION_RULE_UPDATED', 'business', cur.id, { from: before, to: rule }, req.ip);
  res.json(businessAdminView(getBusiness(cur.id)));
});

r.post('/businesses/:id/logo', express.raw({ type: '*/*', limit: '3mb' }), (req, res) => {
  const cur = getBusiness(req.params.id);
  if (!cur) throw new HttpError(404, 'Business not found');
  requireBusinessManage(req, cur.id);
  const file = saveLogo(req.body);
  run('UPDATE businesses SET logo_file = ?, updated_by = ?, updated_at = ? WHERE id = ?', file, req.staff.id, nowIso(), cur.id);
  removeLogo(cur.logo_file);
  audit(A(req), 'BUSINESS_LOGO_UPDATED', 'business', cur.id, null, req.ip);
  res.json({ logo_url: logoUrl(file) });
});
r.delete('/businesses/:id/logo', (req, res) => {
  const cur = getBusiness(req.params.id);
  if (!cur) throw new HttpError(404, 'Business not found');
  requireBusinessManage(req, cur.id);
  run('UPDATE businesses SET logo_file = NULL WHERE id = ?', cur.id);
  removeLogo(cur.logo_file);
  audit(A(req), 'BUSINESS_LOGO_REMOVED', 'business', cur.id, null, req.ip);
  res.json({ ok: true });
});

/* ---------- cross-business settlement ---------- */
r.get('/settlements/report', (req, res) => res.json(settlementReport({ from: req.query.from, to: req.query.to, businessId: scopeBiz(req, req.query.business) })));
r.get('/settlements/open', (req, res) => res.json(openTransactions(scopeBiz(req, req.query.business), { from: req.query.from, to: req.query.to })));
r.get('/settlements', (req, res) => res.json(listSettlements({ businessId: scopeBiz(req, req.query.business) })));
r.get('/settlements/:id', (req, res) => {
  const s = settlementDetail(req.params.id);
  assertInScope(req, s.business_id);
  res.json(s);
});
r.post('/settlements', (req, res) => res.json(createSettlement({ businessId: Number(req.body?.business_id), from: req.body?.from, to: req.body?.to, note: req.body?.note }, req.staff, req.ip)));
r.post('/settlements/:id/settle', (req, res) => res.json(markSettled(req.params.id, req.body || {}, req.staff, req.ip)));
r.post('/settlements/:id/void', (req, res) => res.json(voidSettlement(req.params.id, req.body?.reason, req.staff, req.ip)));

/* ---------- engagement: challenges, reactivation, referrals, interest segments ---------- */
r.get('/challenges/meta', (req, res) => res.json({ types: CHALLENGE_TYPES, periods: PERIODS }));
r.get('/challenges', (req, res) => res.json(challengeList()));
r.post('/challenges', (req, res) => res.json({ id: createChallenge(req.body || {}, req.staff, req.ip) }));
r.put('/challenges/:id', (req, res) => { updateChallenge(Number(req.params.id), req.body || {}, req.staff, req.ip); res.json({ ok: true }); });

r.get('/automations', (req, res) => res.json(automationReport()));
r.post('/automations/preview', (req, res) => res.json(previewAutomation(req.body || {})));
r.post('/automations', (req, res) => res.json({ id: saveAutomation(null, req.body || {}, req.staff, req.ip) }));
r.put('/automations/:id', (req, res) => res.json({ id: saveAutomation(Number(req.params.id), req.body || {}, req.staff, req.ip) }));
r.post('/automations/:id/run', (req, res) => res.json(runAutomations({ id: Number(req.params.id), staff: req.staff, ip: req.ip })[0]));

r.get('/referrals', (req, res) => res.json(referralReport({ status: String(req.query.status || '') })));
r.post('/referrals/programs', (req, res) => res.json({ id: saveProgram(null, req.body || {}, req.staff, req.ip) }));
r.put('/referrals/programs/:id', (req, res) => res.json({ id: saveProgram(Number(req.params.id), req.body || {}, req.staff, req.ip) }));
r.post('/referrals/:id/reject', (req, res) => { rejectReferral(Number(req.params.id), req.body?.reason, req.staff, req.ip); res.json({ ok: true }); });

/** Every segment an offer / challenge / automation can target, with current sizes. */
r.get('/segments/options', (req, res) => {
  const counts = Object.fromEntries(segmentCounts().map((x) => [x.segment, x.n]));
  const codes = new Set([...Object.keys(SEGMENTS), ...Object.keys(counts), ...all('SELECT code FROM interest_segments WHERE active = 1').map((x) => `INT:${x.code}`)]);
  res.json([...codes].map((code) => ({ code, label: segmentLabel(code), n: counts[code] || 0 })).sort((a, b) => a.label.localeCompare(b.label)));
});

function normaliseInterest(b = {}, cur = null) {
  const code = cur ? cur.code : String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,20}$/.test(code)) throw bad('Code: 2–20 letters / digits / _');
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw bad('Name is required');
  const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).join(', ') || null;
  const categories = list(b.categories);
  const keywords = list(b.keywords);
  if (!categories && !keywords) throw bad('Enter at least one category or product keyword');
  const share = Number(b.min_share_pct ?? 15) / 100;
  if (!(share > 0 && share <= 1)) throw bad('Minimum share must be 1–100%');
  const lookback = parseInt(b.lookback_days || 90, 10);
  if (!(lookback >= 7 && lookback <= 365)) throw bad('Look-back must be 7–365 days');
  return { code, name, categories, keywords, min_share: share, min_spend_paise: toPaise(b.min_spend) ?? 0, lookback_days: lookback, active: b.active === false ? 0 : 1 };
}
r.get('/interest-segments', (req, res) => res.json(all(
  "SELECT i.*, (SELECT COUNT(*) FROM customer_segments s WHERE s.segment = 'INT:' || i.code) customers FROM interest_segments i ORDER BY i.name",
)));
r.post('/interest-segments', (req, res) => {
  const x = normaliseInterest(req.body);
  if (get('SELECT 1 FROM interest_segments WHERE code = ?', x.code)) throw bad('Code already exists');
  const id = run('INSERT INTO interest_segments(code, name, categories, keywords, min_share, min_spend_paise, lookback_days, active, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    x.code, x.name, x.categories, x.keywords, x.min_share, x.min_spend_paise, x.lookback_days, x.active, nowIso()).lastInsertRowid;
  recomputeSegments();
  audit(A(req), 'INTEREST_SEGMENT_CREATED', 'interest_segment', id, x, req.ip);
  res.json({ id: Number(id) });
});
r.put('/interest-segments/:id', (req, res) => {
  const cur = get('SELECT * FROM interest_segments WHERE id = ?', req.params.id);
  if (!cur) throw new HttpError(404, 'Not found');
  const x = normaliseInterest(req.body, cur);
  run('UPDATE interest_segments SET name = ?, categories = ?, keywords = ?, min_share = ?, min_spend_paise = ?, lookback_days = ?, active = ?, updated_at = ? WHERE id = ?',
    x.name, x.categories, x.keywords, x.min_share, x.min_spend_paise, x.lookback_days, x.active, nowIso(), cur.id);
  recomputeSegments();
  audit(A(req), 'INTEREST_SEGMENT_UPDATED', 'interest_segment', cur.id, x, req.ip);
  res.json({ ok: true });
});

/* ---------- customer care contact (shown in the Customer App) ---------- */
r.get('/contact', (req, res) => res.json(careInfo()));
r.put('/contact', (req, res) => {
  const v = saveCareInfo(req.body);
  audit(A(req), 'CONTACT_UPDATED', 'settings', null, v, req.ip);
  res.json({ ok: true, ...v });
});

r.get('/staff/roles', (req, res) => res.json(ACCESS_ROLES));
r.get('/staff', (req, res) => res.json(all(
  `SELECT s.id, s.username, s.name, s.role, s.access_role, s.business_id, s.branch_id, s.active, s.created_at, s.last_login_at, b.name branch, bz.name business
     FROM staff s LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN businesses bz ON bz.id = COALESCE(s.business_id, b.business_id)
    ORDER BY s.role, bz.name, b.name, s.name`,
).map((s) => ({ ...s, access_role: accessRoleOf(s), access_label: ACCESS_ROLES[accessRoleOf(s)]?.label }))));

/** Validate role + branch / business for a login. Returns the columns to store. */
function staffAccess(accessRole, branchId, businessId) {
  const def = ACCESS_ROLES[accessRole];
  if (!def) throw bad('Choose a role');
  const out = { access_role: accessRole, role: def.panel, branch_id: null, business_id: null };
  if (def.branch) {
    if (!get('SELECT 1 FROM branches WHERE id = ?', branchId)) throw bad('Select the branch / outlet for this login');
    out.branch_id = Number(branchId);
  }
  if (def.business === 'required' || (def.business === 'optional' && businessId)) {
    if (!get('SELECT 1 FROM businesses WHERE id = ?', businessId)) throw bad('Select the business for this login');
    out.business_id = Number(businessId);
  }
  return out;
}
const activeSuperAdmins = (exceptId) => get(
  "SELECT COUNT(*) n FROM staff WHERE active = 1 AND COALESCE(access_role, CASE role WHEN 'ADMIN' THEN 'SUPER_ADMIN' END) = 'SUPER_ADMIN' AND id <> ?", exceptId,
).n;

r.post('/staff', (req, res) => {
  const { username, name, branch_id, business_id, password } = req.body || {};
  const accessRole = req.body?.access_role || (req.body?.role === 'MANAGER' ? 'BRANCH_MANAGER' : req.body?.role === 'ADMIN' ? 'SUPER_ADMIN' : null);
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) throw bad('Username: 3–30 letters, digits, . _ -');
  if (!String(name || '').trim()) throw bad('Name is required');
  const acc = staffAccess(accessRole, branch_id, business_id);
  if (String(password || '').length < 8) throw bad('Password must be at least 8 characters');
  if (get('SELECT 1 FROM staff WHERE username = ?', u)) throw bad('Username already exists');
  const id = run('INSERT INTO staff(username, name, role, access_role, branch_id, business_id, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?)',
    u, String(name).trim(), acc.role, acc.access_role, acc.branch_id, acc.business_id, hashPassword(String(password)), nowIso()).lastInsertRowid;
  audit(A(req), 'STAFF_CREATED', 'staff', id, { username: u, ...acc }, req.ip);
  res.json({ id: Number(id) });
});

r.put('/staff/:id', (req, res) => {
  const s = get('SELECT * FROM staff WHERE id = ?', req.params.id);
  if (!s) throw new HttpError(404, 'Staff not found');
  const b = req.body || {};
  if (s.id === req.staff.id && b.active === false) throw bad('You cannot disable your own account');
  const name = b.name === undefined ? s.name : String(b.name).trim();
  const active = b.active === undefined ? s.active : b.active ? 1 : 0;
  const acc = staffAccess(b.access_role ?? accessRoleOf(s), b.branch_id === undefined ? s.branch_id : b.branch_id, b.business_id === undefined ? s.business_id : b.business_id);
  const wasSuper = accessRoleOf(s) === 'SUPER_ADMIN' && s.active;
  if (wasSuper && (acc.access_role !== 'SUPER_ADMIN' || !active) && !activeSuperAdmins(s.id)) throw bad('At least one active Super Admin is required');
  if (s.id === req.staff.id && acc.access_role !== s.access_role) throw bad('You cannot change your own role');
  run('UPDATE staff SET name = ?, active = ?, role = ?, access_role = ?, branch_id = ?, business_id = ? WHERE id = ?',
    name, active, acc.role, acc.access_role, acc.branch_id, acc.business_id, s.id);
  if (b.password) {
    if (String(b.password).length < 8) throw bad('Password must be at least 8 characters');
    run('UPDATE staff SET password_hash = ? WHERE id = ?', hashPassword(String(b.password)), s.id);
  }
  audit(A(req), 'STAFF_UPDATED', 'staff', s.id, { name, active, ...acc, passwordReset: !!b.password }, req.ip);
  res.json({ ok: true });
});

/* ---------- Excel import ---------- */
r.post('/imports', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const out = importWorkbook(req.body, {
    filename: String(req.query.filename || 'upload.xlsx').slice(0, 200),
    staff: req.staff,
    defaultBranchId: req.query.branch ? Number(req.query.branch) : null,
    force: req.query.force === '1',
    ip: req.ip,
    mode: String(req.query.mode || 'AMOUNT').toUpperCase(),
  });
  res.json(out);
});
r.get('/imports', (req, res) => res.json(all(
  'SELECT i.*, s.name uploaded_by_name FROM imports i LEFT JOIN staff s ON s.id = i.uploaded_by ORDER BY i.id DESC LIMIT 200',
)));
r.get('/imports/template', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const mode = String(req.query.mode || '').toUpperCase() === 'POINTS' ? 'POINTS' : 'AMOUNT';
  res.setHeader('Content-Disposition', `attachment; filename="vasantham-pos-upload-${mode === 'POINTS' ? 'points' : 'amount'}-template.xlsx"`);
  res.send(templateWorkbook(mode));
});
r.get('/imports/columns', (req, res) => res.json({ template: TEMPLATE_HEADERS, accepted: FIELDS }));
r.get('/imports/:id', (req, res) => {
  const i = get('SELECT i.*, s.name uploaded_by_name FROM imports i LEFT JOIN staff s ON s.id = i.uploaded_by WHERE i.id = ?', req.params.id);
  if (!i) throw new HttpError(404, 'Upload not found');
  res.json({ ...i, errors: all('SELECT * FROM import_errors WHERE import_id = ? ORDER BY level, row_no LIMIT 2000', i.id) });
});

/* ---------- ledger ---------- */
r.get('/ledger', (req, res) => {
  const { size, offset, page: p } = page(req);
  const where = [];
  const params = [];
  if (req.query.type) { where.push('l.type = ?'); params.push(req.query.type); }
  if (req.query.branch) { where.push('l.branch_id = ?'); params.push(Number(req.query.branch)); }
  if (isDate(req.query.from)) { where.push("date(l.created_at,'+330 minutes') >= ?"); params.push(req.query.from); }
  if (isDate(req.query.to)) { where.push("date(l.created_at,'+330 minutes') <= ?"); params.push(req.query.to); }
  if (req.query.q) { where.push('(c.mobile LIKE ? OR c.code = ?)'); params.push(`%${req.query.q}%`, String(req.query.q).toUpperCase()); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totals = get(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN l.cp > 0 THEN l.cp END),0) credit, COALESCE(SUM(CASE WHEN l.cp < 0 THEN l.cp END),0) debit
                        FROM points_ledger l JOIN customers c ON c.id = l.customer_id ${w}`, ...params);
  const rows = all(
    `SELECT l.*, c.mobile, c.name customer_name, c.code, b.name branch, p.bill_date FROM points_ledger l JOIN customers c ON c.id = l.customer_id
       LEFT JOIN branches b ON b.id = l.branch_id LEFT JOIN purchases p ON p.id = l.purchase_id ${w} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ...params, size, offset,
  );
  res.json({ total: totals.n, credit_cp: totals.credit, debit_cp: totals.debit, page: p, size, rows });
});

/* ---------- offers ---------- */
const OFFER_COLS = ['title', 'description', 'type', 'audience', 'coupon_code', 'min_spend_paise', 'value_paise', 'category', 'product', 'bonus_cp', 'multiplier',
  'valid_from', 'valid_to', 'max_uses_per_customer', 'branch_ids', 'active', 'business_id', 'points_cost_cp', 'cost_paise', 'funding_type',
  'funder_business_id', 'partner_share_paise', 'terms', 'target_segments'];
function insertOffer(o, staffId, campaignId = null) {
  const cols = [...OFFER_COLS, 'campaign_id', 'created_by', 'created_at'];
  return Number(run(`INSERT INTO offers(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`,
    ...OFFER_COLS.map((k) => o[k] ?? null), campaignId, staffId, nowIso()).lastInsertRowid);
}
r.get('/offers/types', (req, res) => res.json(OFFER_TYPES));
r.get('/offers', (req, res) => res.json(all(
  `SELECT o.*, (SELECT COUNT(*) FROM offer_assignments a WHERE a.offer_id = o.id) assigned,
          (SELECT COUNT(*) FROM redemptions r WHERE r.offer_id = o.id AND r.status IN ('APPROVED','SUBMITTED','BILLED','RECONCILED')) redeemed,
          (SELECT COUNT(DISTINCT purchase_id) FROM points_ledger l WHERE l.offer_id = o.id AND l.type = 'BONUS') auto_applied,
          c.name campaign_name, bz.name business_name, fz.name funder_name
     FROM offers o LEFT JOIN campaigns c ON c.id = o.campaign_id LEFT JOIN businesses bz ON bz.id = o.business_id LEFT JOIN businesses fz ON fz.id = o.funder_business_id
    WHERE (? IS NULL OR o.business_id = ?)
    ORDER BY o.active DESC, o.valid_to DESC, o.id DESC`,
  scopeBiz(req), scopeBiz(req),
).map((o) => ({ ...o, conditions: offerConditions(o), type_label: OFFER_TYPES[o.type]?.label, attachment: attachmentView(o) }))));

/** Business-limited logins only manage their own business's offers, and can't send / assign them to customers. */
function offerInScope(req, offerId) {
  const o = get('SELECT * FROM offers WHERE id = ?', offerId);
  if (!o) throw new HttpError(404, 'Offer not found');
  assertInScope(req, o.business_id);
  return o;
}
const withScope = (req, body = {}) => (req.scope?.businessId ? { ...body, business_id: req.scope.businessId, funding_type: body.funding_type === 'PROGRAM' ? 'PARTNER' : body.funding_type || 'PARTNER', funder_business_id: req.scope.businessId } : body);

r.post('/offers', (req, res) => {
  const o = normaliseOffer(withScope(req, req.body || {}));
  const id = insertOffer(o, req.staff.id);
  audit(A(req), 'OFFER_CREATED', 'offer', id, o, req.ip);
  res.json({ id: Number(id) });
});

r.put('/offers/:id', (req, res) => {
  const cur = offerInScope(req, req.params.id);
  if (req.body && Object.keys(req.body).length === 1 && 'active' in req.body) {
    run('UPDATE offers SET active = ? WHERE id = ?', req.body.active ? 1 : 0, cur.id);
    audit(A(req), req.body.active ? 'OFFER_ACTIVATED' : 'OFFER_DEACTIVATED', 'offer', cur.id, null, req.ip);
    return res.json({ ok: true });
  }
  const o = normaliseOffer(withScope(req, req.body || {}));
  run(`UPDATE offers SET ${OFFER_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...OFFER_COLS.map((k) => o[k]), cur.id);
  audit(A(req), 'OFFER_UPDATED', 'offer', cur.id, o, req.ip);
  res.json({ ok: true });
});

/** Attach an image (JPG/PNG/WebP) or PDF to an offer; replaces any earlier one. Body is the raw file. */
r.post('/offers/:id/attachment', express.raw({ type: '*/*', limit: '11mb' }), (req, res) => {
  const o = offerInScope(req, req.params.id);
  const a = saveOfferAttachment(req.body, req.query.filename);
  run('UPDATE offers SET attachment_file = ?, attachment_type = ?, attachment_name = ? WHERE id = ?', a.attachment_file, a.attachment_type, a.attachment_name, o.id);
  removeOfferAttachment(o.attachment_file);
  audit(A(req), 'OFFER_ATTACHMENT_ADDED', 'offer', o.id, { name: a.attachment_name, type: a.attachment_type, size: req.body.length }, req.ip);
  res.json({ attachment: attachmentView(a) });
});
r.delete('/offers/:id/attachment', (req, res) => {
  const o = offerInScope(req, req.params.id);
  run('UPDATE offers SET attachment_file = NULL, attachment_type = NULL, attachment_name = NULL WHERE id = ?', o.id);
  removeOfferAttachment(o.attachment_file);
  audit(A(req), 'OFFER_ATTACHMENT_REMOVED', 'offer', o.id, { name: o.attachment_name }, req.ip);
  res.json({ ok: true });
});

/** Send a live offer for everyone to app users as a notification (subject to the daily notification cap). */
r.post('/offers/:id/notify', (req, res) => {
  if (req.scope.businessId) throw new HttpError(403, 'Only the Vasantham loyalty team can send notifications to all customers');
  const o = get('SELECT * FROM offers WHERE id = ?', req.params.id);
  if (!o) throw new HttpError(404, 'Offer not found');
  if (o.audience !== 'GLOBAL') throw bad('Personalised offers notify customers when they are assigned');
  const today = istDate();
  if (!o.active || o.valid_to < today) throw bad('Only an active, unexpired offer can be sent');
  const ids = all("SELECT id FROM customers WHERE status = 'ACTIVE' AND app_registered_at IS NOT NULL").map((x) => x.id);
  let sent = 0;
  tx(() => {
    for (const id of ids) if (notify(id, 'OFFER', o.title, o.description || 'New offer at Vasantham. Tap to view.', o.id)) sent++;
  });
  audit(A(req), 'OFFER_NOTIFIED', 'offer', o.id, { app_users: ids.length, sent }, req.ip);
  res.json({ app_users: ids.length, sent, skipped: ids.length - sent });
});

/** Assign a personalised offer to specific customers (mobiles) or a whole segment. */
r.post('/offers/:id/assign', (req, res) => {
  if (req.scope.businessId) throw new HttpError(403, 'Only the Vasantham loyalty team can assign offers to customers');
  const o = get('SELECT * FROM offers WHERE id = ?', req.params.id);
  if (!o) throw new HttpError(404, 'Offer not found');
  if (o.audience !== 'PERSONAL') throw bad('Only personalised offers can be assigned');
  let ids = [];
  const notFound = [];
  if (req.body?.segment) ids = customersInSegment(req.body.segment);
  else {
    for (const m of String(req.body?.mobiles || '').split(/[\s,;]+/).filter(Boolean)) {
      const mob = normMobile(m);
      const c = mob && get('SELECT id FROM customers WHERE mobile = ?', mob);
      if (c) ids.push(c.id);
      else notFound.push(m);
    }
  }
  const expires = isDate(req.body?.expires_on) ? req.body.expires_on : null;
  const n = assign(o, ids, null, expires);
  audit(A(req), 'OFFER_ASSIGNED', 'offer', o.id, { segment: req.body?.segment, count: n, notFound }, req.ip);
  res.json({ assigned: n, notFound });
});

function assign(o, ids, campaignId, expiresOn) {
  let n = 0;
  const now = nowIso();
  tx(() => {
    for (const id of ids) {
      const r2 = run('INSERT OR IGNORE INTO offer_assignments(offer_id, customer_id, campaign_id, assigned_at, expires_on) VALUES (?,?,?,?,?)', o.id, id, campaignId, now, expiresOn);
      if (r2.changes) {
        n++;
        notify(id, 'OFFER_UNLOCKED', 'A new offer for you', o.title, o.id);
      }
    }
  });
  return n;
}

/* ---------- segments & settings ---------- */
r.get('/segments', (req, res) => res.json({ counts: segmentCounts(), labels: SEGMENTS, computed_at: Number(get("SELECT value FROM settings WHERE key = 'segments_computed_at'")?.value || 0) }));
r.post('/segments/recompute', (req, res) => {
  const n = recomputeSegments();
  audit(A(req), 'SEGMENTS_RECOMPUTED', null, null, { customers: n }, req.ip);
  res.json({ customers: n, counts: segmentCounts() });
});
r.get('/settings', (req, res) => {
  const s = allSettings();
  res.json(Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, s[k]])));
});
r.put('/settings', (req, res) => {
  const changed = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw bad(`Invalid value for ${k}`);
    run('UPDATE settings SET value = ? WHERE key = ?', String(n), k);
    changed[k] = n;
  }
  audit(A(req), 'SETTINGS_UPDATED', 'settings', null, changed, req.ip);
  res.json({ ok: true });
});

/* ---------- campaigns ---------- */
r.get('/campaigns', (req, res) => res.json(all(
  `SELECT c.*, o.title offer_title, o.type offer_type, s.name created_by_name FROM campaigns c LEFT JOIN offers o ON o.id = c.offer_id
     LEFT JOIN staff s ON s.id = c.created_by ORDER BY c.id DESC`,
).map((c) => ({ ...c, segment_label: c.segment === 'ALL' ? 'All customers' : segmentLabel(c.segment) }))));

/** Create a campaign: builds a personalised offer and assigns it to the segment. */
r.post('/campaigns', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) throw bad('Campaign name is required');
  if (!b.segment) throw bad('Choose a target segment');
  const days = parseInt(b.validity_days, 10);
  if (!(days >= 1 && days <= 365)) throw bad('Validity must be 1–365 days');
  const start = isDate(b.start_date) ? b.start_date : istDate();
  const end = addDays(start, days - 1);
  const offer = normaliseOffer({ ...b.offer, title: b.offer?.title || name, audience: 'PERSONAL', valid_from: start, valid_to: end });
  offer.audience = 'PERSONAL';
  const ids = customersInSegment(b.segment);
  if (!ids.length) throw bad('No customers in this segment right now');
  const out = tx(() => {
    const cid = Number(run('INSERT INTO campaigns(name, segment, audience_size, start_date, end_date, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      name, b.segment, ids.length, start, end, String(b.notes || '').trim() || null, req.staff.id, nowIso()).lastInsertRowid);
    const oid = insertOffer({ ...offer, audience: 'PERSONAL', valid_from: start, valid_to: end, active: 1 }, req.staff.id, cid);
    run('UPDATE campaigns SET offer_id = ? WHERE id = ?', oid, cid);
    const n = assign({ id: oid, title: offer.title }, ids, cid, end);
    return { id: cid, offer_id: oid, audience: n };
  });
  audit(A(req), 'CAMPAIGN_CREATED', 'campaign', out.id, { name, segment: b.segment, audience: out.audience, start, end }, req.ip);
  res.json(out);
});
r.get('/campaigns/:id', (req, res) => {
  const rep = campaignReport(req.params.id);
  if (!rep) throw new HttpError(404, 'Campaign not found');
  res.json(rep);
});

/* ---------- redemptions & reconciliation ---------- */
r.get('/redemptions', (req, res) => {
  const { size, offset, page: p } = page(req);
  const where = [];
  const params = [];
  if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }
  if (req.query.branch) { where.push('r.branch_id = ?'); params.push(Number(req.query.branch)); }
  const biz = scopeBiz(req, req.query.business);
  if (biz) { where.push('r.business_id = ?'); params.push(biz); }
  if (isDate(req.query.from)) { where.push("date(r.created_at,'+330 minutes') >= ?"); params.push(req.query.from); }
  if (isDate(req.query.to)) { where.push("date(r.created_at,'+330 minutes') <= ?"); params.push(req.query.to); }
  if (req.query.q) { where.push('(r.id LIKE ? OR c.mobile LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) n FROM redemptions r JOIN customers c ON c.id = r.customer_id ${w}`, ...params).n;
  const statusCounts = all('SELECT status, COUNT(*) n, SUM(value_paise) v FROM redemptions WHERE (? IS NULL OR business_id = ?) GROUP BY status', biz, biz);
  const rows = all(
    `SELECT r.*, c.mobile, c.name customer_name, b.name branch, bz.name business, s.name approved_by_name, o.title offer_title, COALESCE(p.bill_no, r.partner_bill_no) bill_no
       FROM redemptions r JOIN customers c ON c.id = r.customer_id LEFT JOIN branches b ON b.id = r.branch_id LEFT JOIN businesses bz ON bz.id = r.business_id
       LEFT JOIN staff s ON s.id = r.approved_by LEFT JOIN offers o ON o.id = r.offer_id LEFT JOIN purchases p ON p.id = r.purchase_id
       ${w} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    ...params, size, offset,
  ).map((x) => (req.scope.businessId ? { ...x, mobile: maskMobile(x.mobile) } : x)); // partners see masked mobiles
  res.json({ total, page: p, size, rows, statusCounts, cancelReasons: CANCEL_REASONS });
});
r.get('/redemptions/:id', (req, res) => {
  assertInScope(req, get('SELECT business_id FROM redemptions WHERE id = ?', req.params.id)?.business_id);
  res.json(receipt(req.params.id));
});
r.post('/redemptions/:id/cancel', (req, res) => {
  cancelOrReverse(req.params.id, A(req), req.body?.reason, req.body?.note, req.ip);
  res.json(receipt(req.params.id));
});
r.post('/redemptions/:id/reconcile', (req, res) => {
  const note = String(req.body?.note || '').trim();
  if (!note) throw bad('A note is required');
  tx(() => forceReconcile(req.params.id, req.staff, note));
  audit(A(req), 'REDEMPTION_MANUAL_RECONCILE', 'redemption', req.params.id, { note }, req.ip);
  res.json(receipt(req.params.id));
});

r.get('/reconciliation', (req, res) => res.json(reconciliationReport({ status: req.query.status || 'OPEN', branchId: req.query.branch ? Number(req.query.branch) : null })));
r.post('/reconciliation/:id/resolve', (req, res) => {
  resolveIssue(Number(req.params.id), req.staff, req.body?.note, !!req.body?.markReconciled, req.ip);
  res.json({ ok: true });
});

/* ---------- analytics ---------- */
r.get('/analytics/customers', (req, res) => res.json({ ...customerAnalytics(), segments: segmentCounts() }));
r.get('/analytics/branches', (req, res) => {
  const to = isDate(req.query.to) ? req.query.to : istDate();
  const from = isDate(req.query.from) ? req.query.from : addDays(to, -29);
  res.json({ from, to, rows: branchAnalytics(from, to) });
});

/* ---------- audit ---------- */
r.get('/audit', (req, res) => {
  const { size, offset, page: p } = page(req);
  const where = [];
  const params = [];
  if (req.query.action) { where.push('a.action = ?'); params.push(req.query.action); }
  if (req.query.actor) { where.push('a.actor_type = ?'); params.push(req.query.actor); }
  if (req.query.entity_id) { where.push('a.entity_id = ?'); params.push(String(req.query.entity_id)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) n FROM audit_logs a ${w}`, ...params).n;
  const rows = all(`SELECT a.*, b.name branch FROM audit_logs a LEFT JOIN branches b ON b.id = a.branch_id ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, size, offset);
  const actions = all('SELECT DISTINCT action FROM audit_logs ORDER BY action').map((x) => x.action);
  res.json({ total, page: p, size, rows, actions });
});

export default r;
