// End-to-end: Phase 2 engagement — spend milestones, visit challenges, referrals, reactivation, targeting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-eng-'));
process.env.DB_FILE = ':memory:';
process.env.DEV_OTP = '1';

const { run, get } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { periodOf } = await import('../src/challenges.js');
const { grantOffer } = await import('../src/rewards.js');
const { addDays } = await import('../src/util.js');
const XLSX = await import('xlsx');

let server, base, adminTok, hof, offers = {};
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dmy = (iso) => iso.split('-').reverse().join('-');
const A = '9876600001'; // regular shopper, referrer
const B = '9876600002'; // visit challenge, nuts buyer
const C = '9876600003'; // new customer, referred by A
const D = '9876600004'; // new, never buys → reactivation target

async function api(method, url, body, tok, raw) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, data: await res.json() };
}
const ok = (r, msg) => assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.data)}`);
let billNo = 1;
async function upload(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Bill No', 'Bill Date', 'Branch', 'Customer Mobile', 'Net Eligible Value', 'Bill Type', 'Original Bill No', 'Product', 'Category', 'Item Amount'],
    ...rows.map(([mobile, net, date = today, extra = {}]) => [extra.bill || `E${billNo++}`, dmy(date), 'ANN', mobile, net, extra.type || 'SALE', extra.orig || '', extra.product || '', extra.category || '', extra.item ?? ''])]), 'Bills');
  const r = await api('POST', `/admin/imports?filename=u${billNo}.xlsx`, null, adminTok, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  ok(r, 'upload');
  return r.data;
}
const bal = (m) => get('SELECT balance_cp FROM customers WHERE mobile = ?', m)?.balance_cp;
async function login(mobile) {
  const o = await api('POST', '/auth/customer/otp', { mobile });
  return (await api('POST', '/auth/customer/verify', { mobile, otp: o.data.devOtp })).data.token;
}
const offer = async (body) => {
  const r = await api('POST', '/admin/offers', { valid_from: today, valid_to: addDays(today, 90), ...body }, adminTok);
  ok(r, body.title);
  return r.data.id;
};

before(async () => {
  const now = new Date().toISOString();
  run("INSERT INTO branches(code, name, created_at) VALUES ('ANN','Anna Nagar',?)", now);
  run("INSERT INTO staff(username, name, role, password_hash, created_at) VALUES ('admin','Admin','ADMIN',?,?)", hashPassword('Admin@12345'), now);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
  adminTok = (await api('POST', '/auth/staff/login', { username: 'admin', password: 'Admin@12345' })).data.token;
  hof = (await api('POST', '/admin/businesses', { code: 'HOF', name: 'House of Friez', rule: { limit_type: 'PERCENT', max_percent: 20 } }, adminTok)).data;
  offers.hof50 = await offer({ business_id: hof.id, audience: 'PERSONAL', type: 'COUPON', title: '₹50 HOF reward', value: 50 });
  offers.fries = await offer({ business_id: hof.id, audience: 'PERSONAL', type: 'FREE_PRODUCT', title: 'Welcome fries', product: 'Fries', value: 99, cost: 35 });
  offers.comeback = await offer({ audience: 'PERSONAL', type: 'PERSONAL_DISCOUNT', title: 'Try us: ₹75 off', value: 75, min_spend: 500 });
  offers.globalHof = await offer({ business_id: hof.id, audience: 'GLOBAL', type: 'COUPON', title: 'HOF for all', value: 20 });
});
after(() => server?.close());

test('measurement periods: calendar month, Monday–Sunday week, clipped to validity', () => {
  const ch = { period: 'MONTHLY', valid_from: '2026-01-10', valid_to: '2026-12-31' };
  assert.deepEqual(periodOf(ch, '2026-02-14'), { key: '2026-02', from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(periodOf(ch, '2026-01-20'), { key: '2026-01', from: '2026-01-10', to: '2026-01-31' });
  assert.equal(periodOf(ch, '2026-01-05'), null);
  const wk = { ...ch, period: 'WEEKLY' };
  assert.deepEqual(periodOf(wk, '2026-09-27'), { key: '2026-09-21', from: '2026-09-21', to: '2026-09-27' }); // Sunday → week from Monday 21st
  assert.equal(periodOf({ ...ch, period: 'CAMPAIGN' }, '2026-06-01').key, 'ALL');
});

test('spend milestone: tiered rewards unlock automatically after the upload, once per period, no clawback', async () => {
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const bad = await api('POST', '/admin/challenges', { name: 'x', type: 'SPEND', period: 'MONTHLY', valid_from: monthStart, valid_to: monthEnd,
    tiers: [{ threshold: 2500, reward: { type: 'OFFER', offer_id: offers.globalHof } }] }, adminTok);
  assert.equal(bad.status, 400); // rewards must be personalised offers
  assert.match(bad.data.error, /personalised/);
  const ch = await api('POST', '/admin/challenges', {
    name: 'Monthly Spend Challenge', type: 'SPEND', period: 'MONTHLY', valid_from: monthStart, valid_to: monthEnd,
    tiers: [
      { threshold: 5000, reward: { type: 'OFFER', offer_id: offers.hof50 }, valid_days: 30 },
      { threshold: 2500, reward: { type: 'POINTS', points: 10 } },
      { threshold: 7500, reward: { type: 'POINTS', points: 30 } },
    ],
  }, adminTok);
  ok(ch, 'challenge');

  const u1 = await upload([[A, 3000]]); // 15 points + milestone 1 (10 bonus)
  assert.equal(u1.challengeAwards, 1);
  assert.equal(bal(A), 1500 + 1000);
  const tokA = await login(A);
  let view = (await api('GET', '/me/challenges', null, tokA)).data[0];
  assert.equal(view.progress, 300000);
  assert.equal(view.target, 500000);
  assert.equal(view.remaining, 200000); // ₹2,000 more to unlock the next reward
  assert.match(view.next_reward, /₹50 HOF reward/);
  assert.deepEqual(view.tiers.map((t) => t.achieved), [true, false, false]);

  const u2 = await upload([[A, 2600]]); // ₹5,600 → HOF reward (tier 1 is not given again)
  assert.equal(u2.challengeAwards, 1);
  assert.equal(bal(A), 1500 + 1000 + 1300);
  const m = await api('GET', '/me/marketplace', null, tokA);
  assert.ok(m.data.coupons.some((c) => c.title === '₹50 HOF reward' && c.business_name === 'House of Friez'));
  const notes = (await api('GET', '/me/notifications', null, tokA)).data;
  assert.ok(notes.some((n) => n.kind === 'REWARD_UNLOCKED' && /₹50 HOF reward/.test(n.body)));

  await upload([[A, 2000, today, { type: 'RETURN', orig: 'E2' }]]); // return: progress drops, rewards stay
  view = (await api('GET', '/me/challenges', null, tokA)).data[0];
  assert.equal(view.progress, 360000);
  assert.equal(get("SELECT COUNT(*) n FROM challenge_awards WHERE customer_id = (SELECT id FROM customers WHERE mobile = ?)", A).n, 2);
  const list = (await api('GET', '/admin/challenges', null, adminTok)).data[0];
  assert.equal(list.participants, 1);
  assert.equal(list.tiers[0].awarded_total, 1);
  assert.equal(list.points_given_cp, 1000);
  assert.equal(list.offers_unlocked, 1);
  // tiers are locked once rewards have been given
  const edit = await api('PUT', `/admin/challenges/${ch.data.id}`, { name: 'x', type: 'SPEND', period: 'MONTHLY', valid_from: monthStart, valid_to: monthEnd, tiers: [{ threshold: 100, reward: { type: 'POINTS', points: 1 } }] }, adminTok);
  assert.equal(edit.status, 400);
});

test('visit challenge: distinct qualifying visit days, minimum bill, not repeatable', async () => {
  ok(await api('POST', '/admin/challenges', {
    name: 'Visit 4 times', type: 'VISITS', period: 'CAMPAIGN', min_bill: 300, repeatable: false, valid_from: addDays(today, -10), valid_to: addDays(today, 20),
    tiers: [{ threshold: 4, reward: { type: 'POINTS', points: 20 } }],
  }, adminTok), 'visits');
  await upload([[B, 400, addDays(today, -3)], [B, 350, addDays(today, -2)], [B, 200, addDays(today, -1)], [B, 500, addDays(today, -1)]]);
  const tokB = await login(B);
  let v = (await api('GET', '/me/challenges', null, tokB)).data.find((x) => x.type === 'VISITS');
  assert.equal(v.progress, 3); // the ₹200 bill doesn't count, two bills on one day = one visit
  assert.deepEqual(v.visits, [addDays(today, -3), addDays(today, -2), addDays(today, -1)]);
  const before = bal(B);
  const u = await upload([[B, 320]]);
  assert.equal(u.challengeAwards, 1);
  assert.equal(bal(B), before + 160 + 2000);
  await upload([[B, 900]]); // 5th visit: not repeatable → no second reward
  assert.equal(get("SELECT COUNT(*) n FROM challenge_awards a JOIN challenges c ON c.id = a.challenge_id WHERE c.type = 'VISITS'").n, 1);
  v = (await api('GET', '/me/challenges', null, tokB)).data.find((x) => x.type === 'VISITS');
  assert.equal(v.completed, true);
});

test('segment eligibility: a challenge for a segment ignores other customers', async () => {
  ok(await api('POST', '/admin/challenges', { name: 'High value only', type: 'SPEND', period: 'CAMPAIGN', segment: 'HIGH_VALUE', valid_from: addDays(today, -1), valid_to: today,
    tiers: [{ threshold: 100, reward: { type: 'POINTS', points: 99 } }] }, adminTok));
  const before = bal(B);
  await upload([[B, 400]]);
  assert.equal(bal(B), before + 200); // base points only
  assert.equal((await api('GET', '/me/challenges', null, await login(B))).data.some((c) => c.name === 'High value only'), false);
});

test('referral: new customer qualifies with first eligible purchase; fraud checks', async () => {
  const noProg = await api('POST', '/me/referral', { code: 'VRXXXX' }, await login(C));
  assert.equal(noProg.status, 400);
  const bad = await api('POST', '/admin/referrals/programs', { name: 'x', valid_from: today, valid_to: today, referrer_reward: { type: 'POINTS', points: 0 } }, adminTok);
  assert.equal(bad.status, 400);
  ok(await api('POST', '/admin/referrals/programs', {
    name: 'Refer a friend', valid_from: today, valid_to: addDays(today, 60), min_purchase: 500, qualify_days: 30, max_referrals: 5, max_per_day: 2,
    referrer_reward: { type: 'POINTS', points: 25 }, referee_reward: { type: 'OFFER', offer_id: offers.fries },
  }, adminTok), 'program');

  const tokA = await login(A);
  const ra = (await api('GET', '/me/referral', null, tokA)).data;
  assert.match(ra.code, /^VR[A-Z2-9]{6}$/);
  assert.equal(ra.program.referrer_reward, '25.00 bonus points');
  assert.equal(ra.can_apply.ok, false); // A already shops: can't be referred

  const tokC = await login(C);
  assert.equal((await api('POST', '/me/referral', { code: 'VRNOPE12' }, tokC)).status, 400);
  const own = (await api('GET', '/me/referral', null, tokC)).data.code;
  assert.equal((await api('POST', '/me/referral', { code: own }, tokC)).status, 400); // self-referral
  ok(await api('POST', '/me/referral', { code: ra.code.toLowerCase() }, tokC), 'apply');
  assert.equal((await api('POST', '/me/referral', { code: ra.code }, tokC)).status, 400); // only once
  assert.equal((await api('POST', '/me/referral', { code: ra.code }, tokA)).status, 400); // existing customer
  // C can't refer A back (loop), and C has not shopped so C's code is not active yet
  assert.equal((await api('POST', '/me/referral', { code: own }, await login(D))).status, 400);

  const aBefore = bal(A);
  await upload([[C, 400]]); // below ₹500: still pending
  assert.equal(get('SELECT status FROM referrals').status, 'PENDING');
  const u = await upload([[C, 650]]);
  assert.equal(u.referralsRewarded, 1);
  assert.equal(get('SELECT status FROM referrals').status, 'REWARDED');
  assert.equal(bal(A), aBefore + 2500);
  const mc = await api('GET', '/me/marketplace', null, tokC);
  assert.ok(mc.data.coupons.some((x) => x.title === 'Welcome fries'));

  // daily cap: A's code already used by C today; max 2/day → one more works, the next fails
  const tokE = await login('9876600005');
  ok(await api('POST', '/me/referral', { code: ra.code }, tokE), 'second today');
  const tokF = await login('9876600006');
  const capped = await api('POST', '/me/referral', { code: ra.code }, tokF);
  assert.equal(capped.status, 400);
  assert.match(capped.data.error, /too many times today/);
  // admin rejects a suspicious pending referral
  const rep = (await api('GET', '/admin/referrals?status=PENDING', null, adminTok)).data;
  assert.equal(rep.rows.length, 1);
  ok(await api('POST', `/admin/referrals/${rep.rows[0].id}/reject`, { reason: 'Same household device' }, adminTok));
  const rep2 = (await api('GET', '/admin/referrals', null, adminTok)).data;
  assert.equal(rep2.programs[0].stats.rewarded, 1);
  assert.equal(rep2.programs[0].stats.rejected, 1);
});

test('reactivation automation: preview, target once per cooldown, measure recovery', async () => {
  await login(D);
  ok(await api('POST', '/admin/segments/recompute', {}, adminTok));
  const body = { name: 'Nudge new members', segment: 'NO_PURCHASE', offer_id: offers.comeback, reward_valid_days: 14, cooldown_days: 30, window_days: 30, active: true, message: 'Your first visit: ₹75 off' };
  const pv = await api('POST', '/admin/automations/preview', body, adminTok);
  ok(pv);
  assert.ok(pv.data.would_target >= 1);
  const a = await api('POST', '/admin/automations', body, adminTok);
  ok(a);
  const run1 = await api('POST', `/admin/automations/${a.data.id}/run`, {}, adminTok);
  assert.equal(run1.data.targeted, pv.data.would_target);
  const run2 = await api('POST', `/admin/automations/${a.data.id}/run`, {}, adminTok);
  assert.equal(run2.data.targeted, 0); // cooldown
  const tokD = await login(D);
  assert.ok((await api('GET', '/me/marketplace', null, tokD)).data.coupons.some((c) => c.title === 'Try us: ₹75 off'));
  await upload([[D, 800]]);
  const rep = (await api('GET', '/admin/automations', null, adminTok)).data.find((x) => x.id === a.data.id);
  assert.equal(rep.recovered, 1);
  assert.equal(rep.revenue_paise, 80000);
  assert.ok(rep.recovery_rate > 0);
});

test('cross-business targeting: interest segment from basket + offer shown only to that segment', async () => {
  ok(await api('POST', '/admin/interest-segments', { code: 'NUTS', name: 'Nuts & health', keywords: 'almond, cashew', categories: 'Dry Fruits', min_share_pct: 30 }, adminTok));
  await upload([
    [B, 1000, today, { bill: 'N1', product: 'Almonds 500g', category: 'Grocery', item: 700 }],
    [B, 1000, today, { bill: 'N1', product: 'Rice 1kg', category: 'Grocery', item: 300 }],
  ]);
  assert.ok(get("SELECT 1 FROM customer_segments s JOIN customers c ON c.id = s.customer_id WHERE c.mobile = ? AND s.segment = 'INT:NUTS'", B));
  const opts = (await api('GET', '/admin/segments/options', null, adminTok)).data;
  assert.equal(opts.find((o) => o.code === 'INT:NUTS').label, 'Interest: Nuts & health');
  await offer({ business_id: hof.id, type: 'COUPON', title: 'Nut lovers ₹30 off', value: 30, target_segments: ['INT:NUTS'] });
  const seen = async (m) => (await api('GET', '/me/marketplace', null, await login(m))).data.businesses.find((b) => b.code === 'HOF').rewards.some((r) => r.title === 'Nut lovers ₹30 off');
  assert.equal(await seen(B), true);
  assert.equal(await seen(A), false);
});

test('each reward grant is one more use of the offer', async () => {
  const c = get('SELECT * FROM customers WHERE mobile = ?', A);
  const o = get('SELECT * FROM offers WHERE id = ?', offers.hof50); // A already unlocked it once via the milestone
  grantOffer(c.id, o, { validDays: 10, source: 'TEST' });
  const coupon = (await api('GET', '/me/marketplace', null, await login(A))).data.coupons.find((x) => x.id === offers.hof50);
  assert.equal(coupon.uses_left, 2);
});
