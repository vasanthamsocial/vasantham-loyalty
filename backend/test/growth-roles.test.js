// End-to-end: Phase 3 — ecosystem growth dashboard figures and role-based access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-gr-'));
process.env.DB_FILE = ':memory:';
process.env.DEV_OTP = '1';

const { run, get } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { rebuildActivity } = await import('../src/growth.js');
const XLSX = await import('xlsx');

let server, base, tok = {}, hof, vsm, hofBranch, xRed, yRed;
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dmy = (iso) => iso.split('-').reverse().join('-');
const X = '9876700001';
const Y = '9876700002';

async function api(method, url, body, t, raw) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, data: await res.json() };
}
const ok = (r, msg) => assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.data)}`);
const login = async (u) => (await api('POST', '/auth/staff/login', { username: u, password: 'Password@1' })).data.token;
async function upload(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Bill No', 'Bill Date', 'Branch', 'Customer Mobile', 'Net Eligible Value', 'Loyalty Ref', 'Loyalty Discount'], ...rows]), 'Bills');
  const r = await api('POST', `/admin/imports?filename=g${Math.random()}.xlsx`, null, tok.admin, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  ok(r, 'upload');
  return r.data;
}
async function customerQr(mobile) {
  const o = await api('POST', '/auth/customer/otp', { mobile });
  const t = (await api('POST', '/auth/customer/verify', { mobile, otp: o.data.devOtp })).data.token;
  return (await api('GET', '/me/qr', null, t)).data.payload;
}

before(async () => {
  const now = new Date().toISOString();
  run("INSERT INTO branches(code, name, created_at) VALUES ('ANN','Anna Nagar',?)", now);
  run("INSERT INTO staff(username, name, role, password_hash, created_at) VALUES ('admin','Admin','ADMIN',?,?)", hashPassword('Password@1'), now);
  run("INSERT INTO staff(username, name, role, branch_id, password_hash, created_at) VALUES ('ann','Ann Mgr','MANAGER',1,?,?)", hashPassword('Password@1'), now);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
  tok.admin = await login('admin');
  tok.ann = await login('ann');
  vsm = get('SELECT * FROM businesses WHERE is_program_owner = 1');
  hof = (await api('POST', '/admin/businesses', { code: 'HOF', name: 'House of Friez', rule: { limit_type: 'PERCENT', max_percent: 20 } }, tok.admin)).data;
  hofBranch = (await api('POST', '/admin/branches', { code: 'HOF1', name: 'HOF Anna Nagar', business_id: hof.id }, tok.admin)).data.id;
  const staff = [
    ['vadmin', 'VASANTHAM_ADMIN', {}], ['hofowner', 'BUSINESS_ADMIN', { business_id: hof.id }], ['report', 'REPORTING', {}],
    ['reporthof', 'REPORTING', { business_id: hof.id }], ['hofmgr', 'BRANCH_MANAGER', { branch_id: hofBranch }], ['redmgr', 'REDEMPTION_MANAGER', { branch_id: hofBranch }],
  ];
  for (const [u, role, extra] of staff) {
    ok(await api('POST', '/admin/staff', { username: u, name: u, access_role: role, password: 'Password@1', ...extra }, tok.admin), u);
    tok[u] = await login(u);
  }
});
after(() => server?.close());

test('staff roles: validation and lock-out protection', async () => {
  assert.equal((await api('POST', '/admin/staff', { username: 'x1', name: 'x', access_role: 'BUSINESS_ADMIN', password: 'Password@1' }, tok.admin)).status, 400); // needs a business
  assert.equal((await api('POST', '/admin/staff', { username: 'x2', name: 'x', access_role: 'REDEMPTION_MANAGER', password: 'Password@1' }, tok.admin)).status, 400); // needs a branch
  const admin = get("SELECT id FROM staff WHERE username = 'admin'").id;
  assert.equal((await api('PUT', `/admin/staff/${admin}`, { access_role: 'REPORTING' }, tok.admin)).status, 400); // own role / last super admin
  const list = (await api('GET', '/admin/staff', null, tok.admin)).data;
  assert.equal(list.find((s) => s.username === 'hofowner').business, 'House of Friez');
  assert.equal(list.find((s) => s.username === 'ann').access_role, 'BRANCH_MANAGER'); // existing managers keep working
  const me = (await api('GET', '/admin/me', null, tok.hofowner)).data;
  assert.equal(me.access_role, 'BUSINESS_ADMIN');
  assert.equal(me.business_name, 'House of Friez');
});

test('journey data: Vasantham purchases, a HOF redemption and a reconciled Vasantham redemption', async () => {
  await upload([['G1', dmy(today), 'ANN', X, 10000, '', ''], ['G2', dmy(today), 'ANN', Y, 5000, '', '']]); // X 50 pts, Y 25 pts
  // X redeems at HOF: 25 points (₹50) on a ₹300 bill, bill confirmed by the outlet
  const sx = await api('POST', '/manager/scan', { code: await customerQr(X) }, tok.hofmgr);
  const rx = await api('POST', '/manager/redemptions/direct', { ticket: sx.data.ticket, kind: 'POINTS', points: '25', bill_amount: 300 }, tok.hofmgr);
  ok(rx, 'hof redemption');
  xRed = rx.data.id;
  ok(await api('POST', `/manager/redemptions/${xRed}/bill`, { bill_no: 'H-1', bill_amount: 300 }, tok.redmgr), 'redemption manager confirms bill');
  // Y redeems 10 points (₹20) at Vasantham; the bill arrives in the next upload with the redemption ID
  const sy = await api('POST', '/manager/scan', { code: await customerQr(Y) }, tok.ann);
  const ry = await api('POST', '/manager/redemptions/direct', { ticket: sy.data.ticket, kind: 'POINTS', points: '10' }, tok.ann);
  ok(ry, 'vsm redemption');
  yRed = ry.data.id;
  const u = await upload([['G3', dmy(today), 'ANN', Y, 1000, yRed, 20]]);
  assert.equal(u.reconciled, 1);
});

test('growth dashboard: key ratio, first-time customers, movement, repeat after first redemption', async () => {
  const g = await api('GET', `/admin/growth?from=${today}&to=${today}`, null, tok.admin);
  ok(g);
  const k = g.data.key_metric;
  assert.equal(k.linked_revenue_paise, 30000 + 100000); // HOF confirmed bill + reconciled Vasantham bill
  assert.equal(k.reward_value_paise, 5000 + 2000);
  assert.equal(Math.round(k.ratio * 100) / 100, 18.57);
  assert.match(k.note, /not incremental/);
  const ft = Object.fromEntries(g.data.first_time.map((f) => [f.name, f]));
  assert.equal(ft['Vasantham Super Mart'].first_time, 2);
  assert.equal(ft['House of Friez'].first_time, 1);
  assert.equal(ft['House of Friez'].via_redemption, 1); // HOF gained a customer through the ecosystem
  assert.equal(g.data.ecosystem.redeeming_elsewhere, 1);
  assert.equal(g.data.ecosystem.vasantham_shoppers, 1);
  assert.equal(g.data.ecosystem.multi_business, 1);
  assert.equal(g.data.movement[0].name, 'House of Friez');
  assert.equal(g.data.movement[0].also_vasantham, 1);
  assert.equal(g.data.redemptions.avg_linked_bill_paise, 65000);
  assert.equal(g.data.customers.total, 2);
  assert.equal(g.data.customers.active, 2);
  assert.equal(g.data.customers.redemption_rate, 1);
  assert.equal(g.data.trend.length, 6);
  assert.equal(g.data.trend[5].reward_value_paise, 7000);

  // X's first ecosystem redemption was 5 days ago; a purchase today makes X a repeat customer
  const past = new Date(Date.now() - 5 * 86400e3).toISOString();
  run('UPDATE redemptions SET approved_at = ? WHERE id = ?', past, xRed);
  await upload([['G4', dmy(today), 'ANN', X, 400, '', '']]);
  rebuildActivity();
  const from = new Date(Date.now() + 330 * 60000 - 10 * 86400e3).toISOString().slice(0, 10);
  const g2 = (await api('GET', `/admin/growth?from=${from}&to=${today}`, null, tok.admin)).data;
  assert.equal(g2.repeat.first_redeemers, 2);
  assert.equal(g2.repeat.repeated, 1);
  assert.equal(g2.repeat.repeat_rate, 0.5);
});

test('Vasantham Admin: operations yes, ecosystem configuration / staff / settings no', async () => {
  const t = tok.vadmin;
  ok(await api('GET', '/admin/growth', null, t));
  ok(await api('GET', '/admin/customers', null, t));
  ok(await api('GET', '/admin/settlements/report?from=' + today + '&to=' + today, null, t));
  assert.equal((await api('GET', '/admin/staff', null, t)).status, 403);
  assert.equal((await api('PUT', '/admin/settings', { notif_daily_cap: 5 }, t)).status, 403);
  assert.equal((await api('POST', '/admin/businesses', { code: 'ZZ', name: 'Z' }, t)).status, 403);
  assert.equal((await api('POST', '/admin/settlements', { business_id: hof.id, from: today, to: today }, t)).status, 403);
});

test('Business Owner: own business only, customer data hidden, own offers are partner-funded', async () => {
  const t = tok.hofowner;
  assert.equal((await api('GET', '/admin/customers', null, t)).status, 403);
  assert.equal((await api('GET', '/admin/dashboard', null, t)).status, 403);
  assert.equal((await api('POST', '/admin/imports?filename=x.xlsx', null, t, Buffer.from('x'))).status, 403);
  const g = (await api('GET', `/admin/growth?from=${today}&to=${today}&business=${vsm.id}`, null, t)).data;
  assert.equal(g.business_id, hof.id); // asking for Vasantham still returns HOF only
  assert.equal(g.per_business.length, 1);
  assert.equal(g.customers, undefined); // no Vasantham-wide customer figures
  const biz = (await api('GET', '/admin/businesses', null, t)).data;
  assert.deepEqual(biz.map((b) => b.code), ['HOF']);
  assert.equal((await api('GET', `/admin/businesses/${vsm.id}`, null, t)).status, 403);
  // profile edits only: permissions and rules are ignored
  ok(await api('PUT', `/admin/businesses/${hof.id}`, { tagline: 'Hot fries, cold drinks', can_earn: true, rule: { limit_type: 'NONE' } }, t));
  const h = get('SELECT * FROM businesses WHERE id = ?', hof.id);
  assert.equal(h.tagline, 'Hot fries, cold drinks');
  assert.equal(h.can_earn, 0);
  assert.equal(get('SELECT limit_type FROM business_redemption_rules WHERE business_id = ?', hof.id).limit_type, 'PERCENT');
  assert.equal((await api('PUT', `/admin/businesses/${vsm.id}`, { tagline: 'x' }, t)).status, 403);
  // offers: created for HOF and funded by HOF, whatever the request says
  const o = await api('POST', '/admin/offers', { business_id: vsm.id, type: 'COUPON', title: 'HOF ₹30', value: 30, funding_type: 'PROGRAM', valid_from: today, valid_to: today }, t);
  ok(o, 'offer');
  const row = get('SELECT * FROM offers WHERE id = ?', o.data.id);
  assert.equal(row.business_id, hof.id);
  assert.equal(row.funding_type, 'PARTNER');
  assert.equal(row.funder_business_id, hof.id);
  const vsmOffer = (await api('POST', '/admin/offers', { type: 'COUPON', title: 'VSM ₹10', value: 10, valid_from: today, valid_to: today }, tok.admin)).data.id;
  assert.equal((await api('PUT', `/admin/offers/${vsmOffer}`, { active: false }, t)).status, 403);
  assert.ok((await api('GET', '/admin/offers', null, t)).data.every((x) => x.business_id === hof.id));
  assert.equal((await api('POST', `/admin/offers/${o.data.id}/notify`, {}, t)).status, 403);
  // redemptions and settlements: own business, masked mobiles
  const red = (await api('GET', '/admin/redemptions', null, t)).data;
  assert.deepEqual(red.rows.map((r) => r.id), [xRed]);
  assert.match(red.rows[0].mobile, /X{6}$/);
  assert.equal((await api('GET', `/admin/redemptions/${yRed}`, null, t)).status, 403);
  assert.equal((await api('POST', `/admin/redemptions/${xRed}/cancel`, { reason: 'Other', note: 'x' }, t)).status, 403);
  const rep = (await api('GET', `/admin/settlements/report?from=${today}&to=${today}`, null, t)).data;
  assert.deepEqual(rep.rows.map((r) => r.code), ['HOF']);
  // Vasantham-wide reports are closed to a single-business login, even ones its permissions would allow
  assert.equal((await api('GET', '/admin/reconciliation', null, t)).status, 403);
  assert.equal((await api('GET', '/admin/campaigns', null, tok.reporthof)).status, 403);
  assert.equal((await api('GET', '/admin/dashboard', null, tok.reporthof)).status, 403);
  ok(await api('GET', '/admin/segments/options', null, t));
});

test('Reporting users: read-only; a business-limited one sees one business', async () => {
  ok(await api('GET', '/admin/growth', null, tok.report));
  ok(await api('GET', '/admin/redemptions', null, tok.report));
  ok(await api('GET', '/admin/dashboard', null, tok.report));
  assert.equal((await api('GET', '/admin/customers', null, tok.report)).status, 403);
  assert.equal((await api('POST', '/admin/offers', { type: 'COUPON', title: 'x', value: 1, valid_from: today, valid_to: today }, tok.report)).status, 403);
  assert.equal((await api('POST', `/admin/redemptions/${xRed}/cancel`, { reason: 'Other', note: 'x' }, tok.report)).status, 403);
  assert.equal((await api('PUT', '/admin/challenges/1', { active: false }, tok.report)).status, 403);
  const g = (await api('GET', `/admin/growth?from=${today}&to=${today}`, null, tok.reporthof)).data;
  assert.equal(g.business_id, hof.id);
});

test('Redemption Manager: counter redemptions only', async () => {
  ok(await api('GET', '/manager/meta', null, tok.redmgr));
  const s = await api('POST', '/manager/scan', { code: await customerQr(X) }, tok.redmgr);
  ok(s, 'scan');
  assert.equal((await api('POST', '/manager/enrol', { mobile: '9876700099' }, tok.redmgr)).status, 403);
  assert.equal((await api('GET', '/manager/report', null, tok.redmgr)).status, 403);
  assert.equal((await api('GET', '/admin/me', null, tok.redmgr)).status, 403); // Manager Panel login, not Admin
  ok(await api('POST', '/manager/enrol', { mobile: '9876700099' }, tok.hofmgr)); // a branch manager can
});
