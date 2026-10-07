import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-test-'));
process.env.DB_FILE = ':memory:';
process.env.DEV_OTP = '1';

const { earnCentipoints, cpToPaise, fmtPoints, toPaise, parsePointsInput, normMobile } = await import('../src/util.js');
const { parseDate } = await import('../src/importer.js');
const { run, get } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const XLSX = await import('xlsx');

let server, base, adminTok, mgrTok, mgr2Tok, custTok;
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

async function api(method, url, body, tok, raw) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json();
  return { status: res.status, data };
}

function xlsx(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Bills');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const HEAD = ['Bill No', 'Bill Date', 'Bill Time', 'Branch', 'Customer Mobile', 'Bill Value', 'Discount', 'Net Eligible Value', 'Loyalty Ref', 'Loyalty Discount', 'Bill Type', 'Original Bill No', 'Product', 'Category', 'Item Amount'];
const d = today.split('-').reverse().join('-'); // DD-MM-YYYY

before(async () => {
  const now = new Date().toISOString();
  run("INSERT INTO branches(code, name, created_at) VALUES ('ANN','Anna Nagar',?), ('TNR','T. Nagar',?)", now, now);
  run("INSERT INTO staff(username, name, role, password_hash, created_at) VALUES ('admin','Admin','ADMIN',?,?)", hashPassword('Admin@12345'), now);
  run("INSERT INTO staff(username, name, role, branch_id, password_hash, created_at) VALUES ('ann','Ann Mgr','MANAGER',1,?,?)", hashPassword('Manager@123'), now);
  run("INSERT INTO staff(username, name, role, branch_id, password_hash, created_at) VALUES ('tnr','TNR Mgr','MANAGER',2,?,?)", hashPassword('Manager@123'), now);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
  adminTok = (await api('POST', '/auth/staff/login', { username: 'admin', password: 'Admin@12345' })).data.token;
  mgrTok = (await api('POST', '/auth/staff/login', { username: 'ann', password: 'Manager@123' })).data.token;
  mgr2Tok = (await api('POST', '/auth/staff/login', { username: 'tnr', password: 'Manager@123' })).data.token;
});
after(() => server?.close());

test('points math: ₹200 = 1 point, truncated to 2 decimals, ₹2 per point', () => {
  assert.equal(earnCentipoints(112500), 562); // ₹1,125 → 5.625 → 5.62
  assert.equal(fmtPoints(562), '5.62');
  assert.equal(cpToPaise(562), 1124); // ₹11.24
  assert.equal(earnCentipoints(220000), 1100); // ₹2,200 → 11.00
  assert.equal(earnCentipoints(19999), 99); // ₹199.99 → 0.99
  assert.equal(earnCentipoints(-5000), 0);
  assert.equal(toPaise('₹1,125.50'), 112550);
  assert.equal(parsePointsInput('50'), 5000);
  assert.equal(parsePointsInput('12.5'), 1250);
  assert.throws(() => parsePointsInput('1.234'));
  assert.equal(normMobile('+91 98400 12345'), '9840012345');
  assert.equal(normMobile('12345'), null);
  assert.deepEqual(parseDate('03-09-2026'), { date: '2026-09-03', time: null });
  assert.deepEqual(parseDate('23-Sep-2026'), { date: '2026-09-23', time: null });
});

test('excel import credits points on net value, creates customers, rejects duplicates', async () => {
  const buf = xlsx([
    HEAD,
    ['B1', d, '10:00', 'ANN', '9840012345', 1200, 75, 1125, '', '', 'SALE', '', 'Rice', 'Grocery', 800],
    ['B1', d, '10:00', 'ANN', '9840012345', 1200, 75, 1125, '', '', 'SALE', '', 'Apples', 'Fruits & Vegetables', 325],
    ['B2', d, '11:00', 'ANN', '9840012345', 2500, 300, 2200, '', '', 'SALE', '', '', '', ''],
    ['B3', d, '12:00', 'TNR', '', 640, 0, 640, '', '', 'SALE', '', '', '', ''],
    ['B4', d, '12:00', 'XXX', '9840099999', 640, 0, 640, '', '', 'SALE', '', '', '', ''],
  ]);
  const r = await api('POST', '/admin/imports?filename=day1.xlsx', null, adminTok, buf);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported, 3);
  assert.equal(r.data.items, 2);
  assert.equal(r.data.newCustomers, 1);
  assert.equal(r.data.status, 'COMPLETED_WITH_ERRORS'); // unknown branch XXX
  // 5.62 + 11.00 base + 10 bonus (seeded? no — no offers in test DB) = 16.62
  const c = get("SELECT * FROM customers WHERE mobile = '9840012345'");
  assert.equal(c.balance_cp, 1662);
  const again = await api('POST', '/admin/imports?filename=day1.xlsx', null, adminTok, buf);
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already imported/);
  const forced = await api('POST', '/admin/imports?filename=day1.xlsx&force=1', null, adminTok, buf);
  assert.equal(forced.data.duplicate, 3);
  assert.equal(get("SELECT balance_cp FROM customers WHERE mobile = '9840012345'").balance_cp, 1662);
});

test('customer logs in with same mobile and sees earlier points', async () => {
  const o = await api('POST', '/auth/customer/otp', { mobile: '98400 12345' });
  assert.ok(o.data.devOtp);
  const bad = await api('POST', '/auth/customer/verify', { mobile: '9840012345', otp: '000000' === o.data.devOtp ? '111111' : '000000' });
  assert.equal(bad.status, 400);
  const v = await api('POST', '/auth/customer/verify', { mobile: '9840012345', otp: o.data.devOtp });
  assert.equal(v.status, 200);
  assert.equal(v.data.newAccount, false);
  custTok = v.data.token;
  assert.equal(v.data.customer.profile_complete, false);
  // name plus at least one of birthday / anniversary is mandatory
  const none = await api('PUT', '/me', { name: 'Priya' }, custTok);
  assert.equal(none.status, 400);
  assert.match(none.data.error, /birth or wedding anniversary/);
  const future = await api('PUT', '/me', { name: 'Priya', anniversary: '2099-01-01' }, custTok);
  assert.equal(future.status, 400);
  const ok = await api('PUT', '/me', { name: 'Priya', anniversary: '2015-02-14' }, custTok);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.customer.profile_complete, true);
  assert.equal(ok.data.customer.anniversary, '2015-02-14');
  const change = await api('PUT', '/me', { name: 'Priya', anniversary: '2016-02-14' }, custTok);
  assert.equal(change.status, 400); // locked once set
  const addDob = await api('PUT', '/me', { name: 'Priya', dob: '1990-05-01' }, custTok);
  assert.equal(addDob.data.customer.dob, '1990-05-01');
  assert.equal(addDob.data.customer.anniversary, '2015-02-14');
  const me = await api('GET', '/me', null, custTok);
  assert.equal(me.data.customer.balance, '16.62');
  assert.equal(me.data.customer.reward_value_paise, 3324);
  const hist = await api('GET', '/me/purchases', null, custTok);
  assert.equal(hist.data.length, 2);
});

let redemptionId;
test('app redemption: QR → manager scan → approve deducts points once', async () => {
  const req = await api('POST', '/me/redemptions', { kind: 'POINTS', points: '10' }, custTok);
  assert.equal(req.status, 200, JSON.stringify(req.data));
  assert.equal(req.data.value_paise, 2000);
  const tooMuch = await api('POST', '/me/redemptions', { kind: 'POINTS', points: '99' }, custTok);
  assert.equal(tooMuch.status, 400);
  // the rejected request must not have superseded... it failed validation before cancelling
  const scan = await api('POST', '/manager/scan', { code: req.data.payload }, mgrTok);
  assert.equal(scan.status, 200, JSON.stringify(scan.data));
  assert.equal(scan.data.type, 'REDEMPTION');
  const ok = await api('POST', `/manager/redemptions/${req.data.id}/approve`, { ticket: scan.data.ticket }, mgrTok);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.points, '10.00');
  assert.equal(ok.data.value, '₹20');
  assert.equal(ok.data.branch, 'Anna Nagar');
  assert.equal(ok.data.customer_mobile_masked, '9840XXXXXX');
  redemptionId = ok.data.id;
  // one-time: the same QR can't be used again, at this or any other branch
  const reuse = await api('POST', '/manager/scan', { code: req.data.payload }, mgr2Tok);
  assert.equal(reuse.status, 400);
  const twice = await api('POST', `/manager/redemptions/${req.data.id}/approve`, { ticket: scan.data.ticket }, mgrTok);
  assert.equal(twice.status, 400);
  assert.equal(get("SELECT balance_cp FROM customers WHERE mobile = '9840012345'").balance_cp, 662);
  const sub = await api('POST', `/manager/redemptions/${redemptionId}/submit`, {}, mgrTok);
  assert.equal(sub.data.status, 'SUBMITTED');
});

test('mobile-search redemption requires customer OTP; reversal needs a reason and restores points', async () => {
  const s = await api('GET', '/manager/search?q=9840012345', null, mgr2Tok);
  assert.equal(s.data.otpRequired, true);
  assert.equal(s.data.ticket, null);
  const otp = await api('POST', `/manager/customers/${s.data.customer.id}/otp`, {}, mgr2Tok);
  const v = await api('POST', `/manager/customers/${s.data.customer.id}/verify`, { otp: otp.data.devOtp }, mgr2Tok);
  assert.ok(v.data.ticket);
  // a ticket issued to one manager can't be used by another
  const stolen = await api('POST', '/manager/redemptions/direct', { ticket: v.data.ticket, kind: 'POINTS', points: '1' }, mgrTok);
  assert.equal(stolen.status, 400);
  const dr = await api('POST', '/manager/redemptions/direct', { ticket: v.data.ticket, kind: 'POINTS', points: '5' }, mgr2Tok);
  assert.equal(dr.status, 200, JSON.stringify(dr.data));
  assert.equal(get("SELECT balance_cp FROM customers WHERE mobile = '9840012345'").balance_cp, 162);
  const noReason = await api('POST', `/manager/redemptions/${dr.data.id}/cancel`, {}, mgr2Tok);
  assert.equal(noReason.status, 400);
  const otherBranch = await api('POST', `/manager/redemptions/${dr.data.id}/cancel`, { reason: 'Billing cancelled' }, mgrTok);
  assert.equal(otherBranch.status, 403);
  const rev = await api('POST', `/manager/redemptions/${dr.data.id}/cancel`, { reason: 'Billing cancelled' }, mgr2Tok);
  assert.equal(rev.data.status, 'REVERSED');
  assert.equal(get("SELECT balance_cp FROM customers WHERE mobile = '9840012345'").balance_cp, 662);
  const rep = await api('GET', `/manager/report?date=${today}`, null, mgr2Tok);
  assert.equal(rep.data.cancelled, 1);
});

test('reconciliation: matching bill reconciles, wrong amount and unknown IDs are flagged, returns reverse points', async () => {
  const buf = xlsx([
    HEAD,
    ['B10', d, '18:45', 'ANN', '9840012345', 1000, 20, 980, `Loyalty ${redemptionId}`, 20, 'SALE', '', '', '', ''],
    ['B11', d, '19:00', 'ANN', '9840011111', 500, 50, 450, 'VR-990101-1001', 50, 'SALE', '', '', '', ''],
    ['R1', d, '19:30', 'ANN', '9840012345', 2200, 0, 1100, '', '', 'RETURN', 'B2', '', '', ''],
  ]);
  const r = await api('POST', '/admin/imports?filename=day2.xlsx', null, adminTok, buf);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reconciled, 1);
  assert.equal(r.data.issues, 1);
  const red = get('SELECT * FROM redemptions WHERE id = ?', redemptionId);
  assert.equal(red.status, 'RECONCILED');
  // 6.62 + 4.90 (B10) - 5.50 (half of B2's 11.00 returned) = 6.02
  assert.equal(get("SELECT balance_cp FROM customers WHERE mobile = '9840012345'").balance_cp, 602);
  const rep = await api('GET', '/admin/reconciliation', null, adminTok);
  assert.equal(rep.data.counts.UNMATCHED_ID, 1);
});

test('offers, campaigns, analytics and audit endpoints', async () => {
  const off = await api('POST', '/admin/offers', { title: '₹100 off on ₹1,500', type: 'SPEND_GET_OFF', audience: 'GLOBAL', min_spend: 1500, value: 100, valid_from: today, valid_to: today }, adminTok);
  assert.equal(off.status, 200, JSON.stringify(off.data));
  const camp = await api('POST', '/admin/campaigns', { name: 'Welcome back', segment: 'ACTIVE', validity_days: 7, offer: { type: 'COMEBACK', value: 100, min_spend: 1500 } }, adminTok);
  assert.equal(camp.status, 200, JSON.stringify(camp.data));
  assert.ok(camp.data.audience >= 1);
  const offers = await api('GET', '/me/offers', null, custTok);
  assert.equal(offers.data.everyone.length, 1);
  assert.equal(offers.data.forYou.length, 1);
  // redeem the personalised offer through the app
  const req = await api('POST', '/me/redemptions', { kind: 'OFFER', offerId: camp.data.offer_id }, custTok);
  assert.equal(req.status, 200, JSON.stringify(req.data));
  const scan = await api('POST', '/manager/scan', { code: req.data.payload }, mgrTok);
  // offer has a ₹1,500 minimum bill: the manager must enter the bill, and it must qualify
  const noBill = await api('POST', `/manager/redemptions/${req.data.id}/approve`, { ticket: scan.data.ticket }, mgrTok);
  assert.equal(noBill.status, 400);
  assert.equal(noBill.data.needs_bill, true);
  const small = await api('POST', `/manager/redemptions/${req.data.id}/approve`, { ticket: scan.data.ticket, bill_amount: 900 }, mgrTok);
  assert.equal(small.status, 400);
  const ok = await api('POST', `/manager/redemptions/${req.data.id}/approve`, { ticket: scan.data.ticket, bill_amount: 1800 }, mgrTok);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.bill, '₹1,800');
  const again = await api('POST', '/me/redemptions', { kind: 'OFFER', offerId: camp.data.offer_id }, custTok);
  assert.equal(again.status, 400); // single use
  const me = await api('GET', '/me', null, custTok);
  assert.equal(me.data.savings.total_paise, 2000 + 10000);
  const rep = await api('GET', `/admin/campaigns/${camp.data.id}`, null, adminTok);
  assert.equal(rep.data.redeemed_customers, 1);
  // cashier applied ₹50 instead of the approved ₹100 → flagged, not reconciled
  const wrong = await api('POST', '/admin/imports?filename=day3.xlsx', null, adminTok,
    xlsx([HEAD, ['B20', d, '20:00', 'ANN', '9840012345', 1800, 50, 1750, ok.data.id, 50, 'SALE', '', '', '', '']]));
  assert.equal(wrong.data.reconciled, 0);
  assert.equal(get('SELECT status, recon_status FROM redemptions WHERE id = ?', ok.data.id).recon_status, 'AMOUNT_MISMATCH');
  const rec = await api('GET', '/admin/reconciliation', null, adminTok);
  assert.equal(rec.data.counts.WRONG_AMOUNT, 1);
  for (const u of ['/admin/dashboard', '/admin/liability', '/admin/analytics/customers', '/admin/analytics/branches', '/admin/audit', '/admin/ledger', '/admin/segments', '/admin/redemptions', '/admin/customers']) {
    const x = await api('GET', u, null, adminTok);
    assert.equal(x.status, 200, `${u}: ${JSON.stringify(x.data)}`);
  }
  const liab = await api('GET', '/admin/liability', null, adminTok);
  assert.equal(liab.data.liability_paise, cpToPaise(liab.data.outstanding_cp));
  const forbidden = await api('GET', '/admin/dashboard', null, mgrTok);
  assert.equal(forbidden.status, 403);
});

test('admin sets branch address / phone / WhatsApp and customer care; customer app lists them', async () => {
  const badPhone = await api('PUT', '/admin/branches/1', { phone: 'call us' }, adminTok);
  assert.equal(badPhone.status, 400);
  const badMap = await api('PUT', '/admin/branches/1', { map_url: 'javascript:alert(1)' }, adminTok);
  assert.equal(badMap.status, 400);
  const ok = await api('PUT', '/admin/branches/1', {
    address: '12, 2nd Avenue, Anna Nagar, Chennai 600040', phone: '044 2626 1234', whatsapp: '98400 11111', map_url: 'https://maps.app.goo.gl/abc',
  }, adminTok);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // a partial update keeps the other contact fields
  await api('PUT', '/admin/branches/1', { name: 'Anna Nagar' }, adminTok);
  const care = await api('PUT', '/admin/contact', { care_phone: '1800 425 1234', care_whatsapp: '+91 98400 22222', care_email: 'care@vasantham.in', care_hours: 'Mon–Sat 9–8' }, adminTok);
  assert.equal(care.status, 200, JSON.stringify(care.data));
  assert.equal((await api('PUT', '/admin/contact', { care_email: 'nope' }, adminTok)).status, 400);
  assert.equal((await api('PUT', '/admin/contact', {}, mgrTok)).status, 403);

  const s = await api('GET', '/me/stores', null, custTok);
  assert.equal(s.status, 200);
  const ann = s.data.branches.find((b) => b.id === 1);
  assert.equal(ann.address, '12, 2nd Avenue, Anna Nagar, Chennai 600040');
  assert.equal(ann.phone, '044 2626 1234');
  assert.equal(ann.whatsapp, '919840011111');
  assert.equal(ann.map_url, 'https://maps.app.goo.gl/abc');
  assert.equal(s.data.care.care_phone, '1800 425 1234');
  assert.equal(s.data.care.care_whatsapp, '919840022222');
  assert.equal((await api('GET', '/me/stores')).status, 401);
});

test('offer image / PDF attachment: upload, shown to customers, sent to app users, removed', async () => {
  const root = base.replace(/\/api$/, '');
  const o = await api('POST', '/admin/offers', { type: 'SPEND_GET_OFF', audience: 'GLOBAL', title: 'Festive ₹100 off', min_spend: 1000, value: 100, valid_from: today, valid_to: today }, adminTok);
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const id = o.data.id;
  // content is checked, not the file name
  const txt = await api('POST', `/admin/offers/${id}/attachment?filename=evil.png`, null, adminTok, Buffer.from('<script>alert(1)</script>'));
  assert.equal(txt.status, 400);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  assert.equal((await api('POST', `/admin/offers/${id}/attachment?filename=poster.png`, null, mgrTok, png)).status, 403);
  const up = await api('POST', `/admin/offers/${id}/attachment?filename=poster.png`, null, adminTok, png);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.attachment.kind, 'image');

  const offers = await api('GET', '/me/offers', null, custTok);
  const seen = offers.data.everyone.find((x) => x.id === id);
  assert.equal(seen.attachment.url, up.data.attachment.url);
  const img = await fetch(root + seen.attachment.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(png), 'served image must be byte-for-byte the uploaded one');
  assert.equal((await fetch(`${root}/media/offers/nope.png`)).status, 404);

  // replacing with a PDF deletes the old image
  const pdf = await api('POST', `/admin/offers/${id}/attachment?filename=catalogue.pdf`, null, adminTok, Buffer.from('%PDF-1.4\n%test\n'));
  assert.equal(pdf.data.attachment.kind, 'pdf');
  assert.equal((await fetch(root + up.data.attachment.url)).status, 404);
  assert.equal((await fetch(root + pdf.data.attachment.url)).headers.get('content-type'), 'application/pdf');

  run("UPDATE settings SET value = '50' WHERE key = 'notif_daily_cap'");
  const sent = await api('POST', `/admin/offers/${id}/notify`, {}, adminTok);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.ok(sent.data.sent >= 1);
  const notes = await api('GET', '/me/notifications', null, custTok);
  const n = notes.data.find((x) => x.offer_id === id);
  assert.equal(n.attachment.kind, 'pdf');
  assert.equal(n.title, 'Festive ₹100 off');

  const del = await api('DELETE', `/admin/offers/${id}/attachment`, null, adminTok);
  assert.equal(del.status, 200);
  assert.equal((await fetch(root + pdf.data.attachment.url)).status, 404);
  assert.equal((await api('GET', '/me/offers', null, custTok)).data.everyone.find((x) => x.id === id).attachment, null);
});

test('points-mode upload credits the Points column as given; amount mode still calculates', async () => {
  const PH = ['Bill No', 'Bill Date', 'Branch', 'Customer Mobile', 'Points', 'Bill Type', 'Original Bill No'];
  // no Points column in a points-mode upload -> rejected before anything is imported
  const noCol = await api('POST', '/admin/imports?filename=p0.xlsx&mode=POINTS', null, adminTok, xlsx([['Bill No', 'Bill Date', 'Branch', 'Customer Mobile', 'Net Eligible Value'], ['P0', d, 'ANN', '9840077777', 1000]]));
  assert.equal(noCol.status, 400);
  assert.match(noCol.data.error, /Points/);
  assert.equal((await api('POST', '/admin/imports?filename=px.xlsx&mode=BOGUS', null, adminTok, xlsx([PH]))).status, 400);

  const r = await api('POST', '/admin/imports?filename=p1.xlsx&mode=POINTS', null, adminTok, xlsx([
    PH,
    ['P1', d, 'ANN', '9840077777', 7.559, 'SALE', ''], // truncated to 7.55
    ['P2', d, 'ANN', '9840077777', '', 'SALE', ''], // member bill without points -> error row
    ['P3', d, 'ANN', '9840077777', -4, 'SALE', ''], // negative on a sale -> error row
    ['P4', d, 'ANN', '', 12, 'SALE', ''], // walk-in: stored, nothing credited
    ['PR1', d, 'ANN', '9840077777', 2.5, 'RETURN', 'P1'],
  ]));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mode, 'POINTS', JSON.stringify(r.data.errors));
  assert.equal(r.data.imported, 3);
  assert.equal(r.data.error, 2);
  assert.equal(r.data.creditedCp, 755);
  assert.equal(r.data.reversedCp, 250);
  const c = get("SELECT * FROM customers WHERE mobile = '9840077777'");
  assert.equal(c.balance_cp, 505);
  assert.equal(get("SELECT credited_cp FROM purchases WHERE bill_no = 'P1'").credited_cp, 755);
  assert.equal(get('SELECT calc_mode FROM imports WHERE id = ?', r.data.importId).calc_mode, 'POINTS');

  // a return can never take back more than the original bill earned
  const r2 = await api('POST', '/admin/imports?filename=p2.xlsx&mode=POINTS', null, adminTok, xlsx([PH, ['PR2', d, 'ANN', '9840077777', 99, 'RETURN', 'P1']]));
  assert.equal(r2.data.reversedCp, 505);
  assert.equal(get("SELECT balance_cp FROM customers WHERE mobile = '9840077777'").balance_cp, 0);

  // default (amount) mode is unchanged: ₹1,000 -> 5 points
  const a = await api('POST', '/admin/imports?filename=a1.xlsx', null, adminTok, xlsx([['Bill No', 'Bill Date', 'Branch', 'Customer Mobile', 'Net Eligible Value', 'Points'], ['A1', d, 'TNR', '9840088888', 1000, 999]]));
  assert.equal(a.data.mode, 'AMOUNT');
  assert.equal(get("SELECT credited_cp FROM purchases WHERE bill_no = 'A1'").credited_cp >= 500, true);
  assert.equal(get("SELECT credited_cp FROM purchases WHERE bill_no = 'A1'").credited_cp < 99900, true);

  const tpl = await fetch(`${base}/admin/imports/template?mode=points`, { headers: { Authorization: `Bearer ${adminTok}` } });
  assert.equal(tpl.status, 200);
  assert.match(tpl.headers.get('content-disposition'), /points-template/);
});
