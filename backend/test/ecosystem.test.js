// End-to-end: the multi-business ecosystem journey (earn at Vasantham, redeem at a partner, settle).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-eco-'));
process.env.DB_FILE = ':memory:';
process.env.DEV_OTP = '1';

const { run, get } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const XLSX = await import('xlsx');

let server, base, adminTok, vsmTok, hofTok, mfnTok, custTok, hof, mfn, vsm;
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const d = today.split('-').reverse().join('-');
const MOBILE = '9876500001';

async function api(method, url, body, tok, raw) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, data: await res.json() };
}
const ok = (r, msg) => assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.data)}`);
function xlsx(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Bills');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const balance = () => get('SELECT balance_cp FROM customers WHERE mobile = ?', MOBILE).balance_cp;
const login = async (u, p) => (await api('POST', '/auth/staff/login', { username: u, password: p })).data.token;

before(async () => {
  const now = new Date().toISOString();
  run("INSERT INTO branches(code, name, created_at) VALUES ('ANN','Anna Nagar',?)", now);
  run("INSERT INTO staff(username, name, role, password_hash, created_at) VALUES ('admin','Admin','ADMIN',?,?)", hashPassword('Admin@12345'), now);
  run("INSERT INTO staff(username, name, role, branch_id, password_hash, created_at) VALUES ('ann','Ann Mgr','MANAGER',1,?,?)", hashPassword('Manager@123'), now);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
  adminTok = await login('admin', 'Admin@12345');
  vsmTok = await login('ann', 'Manager@123');
});
after(() => server?.close());

test('admin sets up partner businesses with their own permissions, rules and outlets', async () => {
  vsm = get('SELECT * FROM businesses WHERE is_program_owner = 1');
  assert.equal(vsm.can_earn, 1);
  assert.equal(get('SELECT business_id FROM branches WHERE code = ?', 'ANN').business_id, vsm.id);

  const bad = await api('POST', '/admin/businesses', { code: 'HOF', name: 'House of Friez', rule: { limit_type: 'PERCENT', max_percent: 150 } }, adminTok);
  assert.equal(bad.status, 400);
  const h = await api('POST', '/admin/businesses', {
    code: 'HOF', name: 'House of Friez', category: 'Food', tagline: 'Redeem points on food purchases', can_earn: false, can_redeem: true,
    billing_source: 'MANAGER', settlement_cycle: 'WEEKLY', rule: { limit_type: 'PERCENT', max_percent: 20 },
  }, adminTok);
  ok(h, 'create HOF');
  hof = h.data;
  assert.equal(hof.can_earn, 0);
  assert.deepEqual(hof.rule.lines, ['Points can pay up to 20% of the bill']);
  const m = await api('POST', '/admin/businesses', {
    code: 'MFN', name: 'MF Nuts', category: 'Nuts & dry fruits', can_earn: false, rule: { limit_type: 'AMOUNT', max_value: 75, min_bill: 200 },
  }, adminTok);
  ok(m, 'create MFN');
  mfn = m.data;
  assert.equal((await api('POST', '/admin/businesses', { code: 'HOF', name: 'Dup' }, adminTok)).status, 400);
  assert.equal((await api('GET', '/admin/businesses', null, vsmTok)).status, 403);

  for (const [code, name, biz, user] of [['HOF1', 'HOF Anna Nagar', hof.id, 'hof'], ['MFN1', 'MF Nuts Anna Nagar', mfn.id, 'mfn']]) {
    const b = await api('POST', '/admin/branches', { code, name, business_id: biz }, adminTok);
    ok(b, 'outlet');
    ok(await api('POST', '/admin/staff', { username: user, name: `${name} Mgr`, role: 'MANAGER', branch_id: b.data.id, password: 'Manager@123' }, adminTok));
  }
  hofTok = await login('hof', 'Manager@123');
  mfnTok = await login('mfn', 'Manager@123');
  const meta = await api('GET', '/manager/meta', null, hofTok);
  assert.equal(meta.data.business.name, 'House of Friez');
  assert.equal(meta.data.business.can_earn, false);
});

test('points are earned only at businesses that can earn', async () => {
  const r = await api('POST', '/admin/imports?filename=eco1.xlsx', null, adminTok, xlsx([
    ['Bill No', 'Bill Date', 'Branch', 'Customer Mobile', 'Net Eligible Value'],
    ['V1', d, 'ANN', MOBILE, 30000], // ₹30,000 at Vasantham → 150 points (₹300)
    ['H1', d, 'HOF1', MOBILE, 5000], // HOF can't earn → recorded, no points
  ]));
  ok(r, 'import');
  assert.equal(r.data.imported, 2);
  assert.equal(r.data.creditedCp, 15000);
  assert.ok(r.data.errors.some((e) => /does not earn loyalty points/.test(e.message)));
  assert.equal(balance(), 15000);

  const o = await api('POST', '/auth/customer/otp', { mobile: MOBILE });
  custTok = (await api('POST', '/auth/customer/verify', { mobile: MOBILE, otp: o.data.devOtp })).data.token;
});

test('marketplace shows each business with its own rules and rewards', async () => {
  ok(await api('POST', '/admin/offers', { business_id: hof.id, type: 'FREE_PRODUCT', title: 'Free fries', product: 'Regular fries', value: 99, cost: 30,
    funding_type: 'PARTNER', valid_from: today, valid_to: today }, adminTok), 'fries');
  ok(await api('POST', '/admin/offers', { business_id: hof.id, type: 'FREE_PRODUCT', title: 'Burger for 40 points', product: 'Classic burger', value: 120, cost: 60,
    points_cost: 40, valid_from: today, valid_to: today }, adminTok), 'burger');
  ok(await api('POST', '/admin/offers', { business_id: vsm.id, type: 'COUPON', title: '₹50 off, sponsored by MF Nuts', value: 50,
    funding_type: 'PARTNER', funder_business_id: mfn.id, valid_from: today, valid_to: today }, adminTok), 'sponsored');
  // bonus points can't run at a business that doesn't earn
  assert.equal((await api('POST', '/admin/offers', { business_id: hof.id, type: 'BONUS_POINTS', title: 'x', bonus_points: 5, valid_from: today, valid_to: today }, adminTok)).status, 400);

  const m = await api('GET', '/me/marketplace', null, custTok);
  ok(m);
  const names = m.data.businesses.map((b) => b.name);
  assert.deepEqual(names.slice(0, 1), ['Vasantham Super Mart']);
  assert.ok(names.includes('House of Friez') && names.includes('MF Nuts'));
  const h = m.data.businesses.find((b) => b.code === 'HOF');
  assert.equal(h.max_cp_now, 15000); // % limit needs the bill, so only the balance caps it for now
  assert.equal(h.rewards.length, 2);
  assert.equal(h.rewards.find((x) => x.title === 'Free fries').reward_class, 'PROMO');
  assert.equal(h.rewards.find((x) => x.title.startsWith('Burger')).points_cost, '40.00');
  const mf = m.data.businesses.find((b) => b.code === 'MFN');
  assert.equal(mf.max_cp_now, 3750); // ₹75 cap
});

let hofRedemption;
test('journey: redeem Vasantham points at HOF, capped at 20% of the bill, points deducted immediately', async () => {
  const req = await api('POST', '/me/redemptions', { kind: 'POINTS', points: '150', businessId: hof.id }, custTok);
  ok(req, 'request');
  assert.equal(req.data.business, 'House of Friez');
  // a Vasantham manager can't approve a HOF request
  assert.equal((await api('POST', '/manager/scan', { code: req.data.payload }, vsmTok)).status, 400);
  const scan = await api('POST', '/manager/scan', { code: req.data.payload }, hofTok);
  ok(scan, 'scan');
  assert.equal(scan.data.customer.eligibility.business.name, 'House of Friez');
  const t = scan.data.ticket;
  const noBill = await api('POST', `/manager/redemptions/${req.data.id}/approve`, { ticket: t }, hofTok);
  assert.equal(noBill.status, 400);
  assert.equal(noBill.data.needs_bill, true);
  const over = await api('POST', `/manager/redemptions/${req.data.id}/approve`, { ticket: t, bill_amount: 500 }, hofTok);
  assert.equal(over.status, 400);
  assert.equal(over.data.max_cp, 5000); // 20% of ₹500 = ₹100 = 50 points
  assert.equal(balance(), 15000); // nothing deducted by the failed attempts
  const more = await api('POST', `/manager/redemptions/${req.data.id}/approve`, { ticket: t, bill_amount: 500, points: '200' }, hofTok);
  assert.equal(more.status, 400); // can't approve more than requested
  const okr = await api('POST', `/manager/redemptions/${req.data.id}/approve`, { ticket: t, bill_amount: 500, points: '50' }, hofTok);
  ok(okr, 'approve');
  assert.equal(okr.data.business, 'House of Friez');
  assert.equal(okr.data.points, '50.00');
  assert.equal(okr.data.value, '₹100');
  assert.equal(okr.data.bill, '₹500');
  assert.equal(okr.data.type_label, 'Points redemption');
  assert.deepEqual(okr.data.rule_lines, ['Points can pay up to 20% of the bill']);
  assert.equal(balance(), 10000); // remaining 100 points stay available
  hofRedemption = okr.data.id;
  // one-time
  assert.equal((await api('POST', `/manager/redemptions/${req.data.id}/approve`, { ticket: t, bill_amount: 500 }, hofTok)).status, 400);
  // settlement liability: loyalty fund owes HOF ₹100
  const txn = get('SELECT * FROM settlement_transactions WHERE redemption_id = ?', hofRedemption);
  assert.equal(txn.business_id, hof.id);
  assert.equal(txn.direction, 'PAYABLE');
  assert.equal(txn.amount_paise, 10000);
  // HOF has no Excel upload: the manager confirms the final bill
  assert.equal((await api('POST', `/manager/redemptions/${hofRedemption}/bill`, { bill_no: 'HB-77', bill_amount: 500 }, vsmTok)).status, 403);
  const billed = await api('POST', `/manager/redemptions/${hofRedemption}/bill`, { bill_no: 'HB-77', bill_amount: 500 }, hofTok);
  ok(billed, 'bill');
  assert.equal(billed.data.status, 'RECONCILED');
  assert.equal(billed.data.partner_bill_no, 'HB-77');
});

test('rewards: promotional unlock (no points), points reward, and partner-funded cost', async () => {
  const s = await api('POST', '/manager/scan', { code: (await api('GET', '/me/qr', null, custTok)).data.payload }, hofTok);
  ok(s, 'scan customer');
  const offers = [...s.data.customer.offers.everyone, ...s.data.customer.offers.forYou];
  assert.ok(offers.every((o) => o.business_id === hof.id)); // manager sees only this business's offers
  const fries = offers.find((o) => o.title === 'Free fries');
  const burger = offers.find((o) => o.title.startsWith('Burger'));

  const f = await api('POST', '/manager/redemptions/direct', { ticket: s.data.ticket, kind: 'OFFER', offerId: fries.id, bill_amount: 250 }, hofTok);
  ok(f, 'fries');
  assert.equal(f.data.type_label, 'Promotional reward / coupon');
  assert.equal(balance(), 10000); // promotional unlocks don't use points
  let r = get('SELECT * FROM redemptions WHERE id = ?', f.data.id);
  assert.equal(r.reward_cost_paise, 3000);
  assert.equal(r.partner_funded_paise, 3000); // HOF funds its own fries → nothing to settle
  assert.equal(get('SELECT COUNT(*) n FROM settlement_transactions WHERE redemption_id = ?', f.data.id).n, 0);

  const b = await api('POST', '/manager/redemptions/direct', { ticket: s.data.ticket, kind: 'OFFER', offerId: burger.id, bill_amount: 250 }, hofTok);
  ok(b, 'burger');
  assert.equal(b.data.type_label, 'Points reward');
  assert.equal(balance(), 6000); // 40 points used
  r = get('SELECT * FROM redemptions WHERE id = ?', b.data.id);
  assert.equal(r.program_funded_paise, 6000); // fund pays HOF the ₹60 cost
  ok(await api('POST', `/manager/redemptions/${b.data.id}/bill`, { bill_no: 'HB-78' }, hofTok), 'burger bill');

  // a Vasantham coupon funded by MF Nuts: fund pays Vasantham, MF Nuts owes the fund
  const vs = await api('POST', '/manager/scan', { code: (await api('GET', '/me/qr', null, custTok)).data.payload }, vsmTok);
  const sponsored = vs.data.customer.offers.everyone.find((o) => o.title.startsWith('₹50 off'));
  const c = await api('POST', '/manager/redemptions/direct', { ticket: vs.data.ticket, kind: 'OFFER', offerId: sponsored.id }, vsmTok);
  ok(c, 'sponsored');
  const tx = JSON.parse(get("SELECT json_group_object(direction || ':' || business_id, amount_paise) j FROM settlement_transactions WHERE redemption_id = ?", c.data.id).j);
  assert.equal(tx[`PAYABLE:${vsm.id}`], 5000);
  assert.equal(tx[`RECEIVABLE:${mfn.id}`], 5000);
});

test('MF Nuts rules: flat ₹ cap and minimum bill are enforced by the server', async () => {
  const s = await api('POST', '/manager/scan', { code: (await api('GET', '/me/qr', null, custTok)).data.payload }, mfnTok);
  assert.equal(s.data.customer.eligibility.max_cp_now, 3750);
  const low = await api('POST', '/manager/redemptions/direct', { ticket: s.data.ticket, kind: 'POINTS', points: '10', bill_amount: 150 }, mfnTok);
  assert.equal(low.status, 400); // below ₹200 minimum bill
  const cap = await api('POST', '/manager/redemptions/direct', { ticket: s.data.ticket, kind: 'POINTS', points: '40', bill_amount: 900 }, mfnTok);
  assert.equal(cap.status, 400); // ₹80 > ₹75 cap
  assert.equal(get("SELECT COUNT(*) n FROM redemptions WHERE business_id = ? AND status = 'CREATED'", mfn.id).n, 0); // nothing left behind
  ok(await api('POST', '/manager/redemptions/direct', { ticket: s.data.ticket, kind: 'POINTS', points: '37.5', bill_amount: 900 }, mfnTok), 'mfn ok');
  assert.equal(balance(), 2250);
});

test('settlement: business-wise report, settle a period, reversal lands in the next settlement', async () => {
  const rep = await api('GET', `/admin/settlements/report?from=${today}&to=${today}`, null, adminTok);
  ok(rep);
  const h = rep.data.rows.find((x) => x.code === 'HOF');
  assert.equal(h.redemptions, 3);
  assert.equal(h.points_cp, 5000 + 4000);
  assert.equal(h.payable_paise, 10000 + 6000);
  assert.equal(h.reward_cost_paise, 3000 + 6000);
  assert.equal(h.partner_funded_paise, 3000);
  assert.equal(h.ready_to_settle_paise, 16000);
  const mf = rep.data.rows.find((x) => x.code === 'MFN');
  assert.equal(mf.receivable_paise, 5000);
  assert.equal(mf.payable_paise, 7500);
  // neither redemption is billing-confirmed yet: MF Nuts' own (₹75 payable) and the Vasantham
  // coupon it sponsors (₹50 receivable, waits for the Vasantham Excel upload)
  assert.equal(mf.awaiting_billing_paise, 7500 - 5000);
  assert.equal(mf.ready_to_settle_paise, 0);

  const s = await api('POST', '/admin/settlements', { business_id: hof.id, from: today, to: today }, adminTok);
  ok(s, 'create');
  assert.equal(s.data.payable_paise, 16000);
  assert.equal(s.data.txn_count, 2);
  assert.equal((await api('POST', '/admin/settlements', { business_id: hof.id, from: today, to: today }, adminTok)).status, 400); // nothing left
  assert.equal((await api('POST', `/admin/settlements/${s.data.id}/settle`, {}, adminTok)).status, 400); // reference required
  const paid = await api('POST', `/admin/settlements/${s.data.id}/settle`, { reference: 'NEFT-001' }, adminTok);
  ok(paid, 'settle');
  assert.equal(paid.data.status, 'SETTLED');
  assert.equal(paid.data.settled_paise, 16000);

  // admin reverses the settled HOF points redemption: points back, negative line for the next settlement
  const rev = await api('POST', `/admin/redemptions/${hofRedemption}/cancel`, { reason: 'Billing cancelled' }, adminTok);
  ok(rev, 'reverse');
  assert.equal(balance(), 2250 + 5000);
  const rep2 = (await api('GET', `/admin/settlements/report?from=${today}&to=${today}&business=${hof.id}`, null, adminTok)).data.rows[0];
  assert.equal(rep2.settled_paise, 16000);
  assert.equal(rep2.net_paise, 6000);
  assert.equal(rep2.pending_paise, -10000); // HOF now owes the fund ₹100 back
  const s2 = await api('POST', '/admin/settlements', { business_id: hof.id, from: today, to: today }, adminTok);
  ok(s2, 'second');
  assert.equal(s2.data.payable_paise, -10000);
  const v = await api('POST', `/admin/settlements/${s2.data.id}/void`, { reason: 'wrong period' }, adminTok);
  assert.equal(v.data.status, 'VOID');
  assert.equal(get('SELECT COUNT(*) n FROM settlement_transactions WHERE settlement_id = ?', s2.data.id).n, 0);
  assert.ok(get("SELECT 1 FROM audit_logs WHERE action = 'SETTLEMENT_SETTLED'"));
});

test('earn / redeem permissions are enforced', async () => {
  ok(await api('PUT', `/admin/businesses/${mfn.id}`, { can_redeem: false }, adminTok));
  const m = await api('GET', '/me/marketplace', null, custTok);
  assert.ok(!m.data.businesses.some((b) => b.code === 'MFN'));
  const req = await api('POST', '/me/redemptions', { kind: 'POINTS', points: '5', businessId: mfn.id }, custTok);
  assert.equal(req.status, 400);
  assert.match(req.data.error, /does not accept/);
  assert.equal((await api('PUT', `/admin/businesses/${vsm.id}`, { active: false }, adminTok)).status, 400); // owner can't be switched off
});
