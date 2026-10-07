// Creates starter branches, staff logins and sample offers. Safe to re-run.
import { get, run } from './db.js';
import { hashPassword } from './auth.js';
import { addDays, istDate, nowIso } from './util.js';

const now = nowIso();
const today = istDate();

const branches = [
  ['ANN', 'Anna Nagar', 'Chennai'],
  ['TNR', 'T. Nagar', 'Chennai'],
  ['VEL', 'Velachery', 'Chennai'],
];
for (const [code, name, city] of branches) {
  if (!get('SELECT 1 FROM branches WHERE code = ?', code)) run('INSERT INTO branches(code, name, city, created_at) VALUES (?,?,?,?)', code, name, city, now);
}

const adminPw = process.env.ADMIN_PASSWORD || 'Admin@12345';
const mgrPw = process.env.MANAGER_PASSWORD || 'Manager@123';
const created = [];
function staff(username, name, role, branchCode, pw) {
  if (get('SELECT 1 FROM staff WHERE username = ?', username)) return;
  const b = branchCode ? get('SELECT id FROM branches WHERE code = ?', branchCode) : null;
  run('INSERT INTO staff(username, name, role, branch_id, password_hash, created_at) VALUES (?,?,?,?,?,?)', username, name, role, b?.id ?? null, hashPassword(pw), now);
  created.push(`${role.padEnd(8)} ${username.padEnd(12)} ${pw}`);
}
staff('admin', 'Head Office Admin', 'ADMIN', null, adminPw);
staff('ann.manager', 'Anna Nagar Manager', 'MANAGER', 'ANN', mgrPw);
staff('tnr.manager', 'T. Nagar Manager', 'MANAGER', 'TNR', mgrPw);
staff('vel.manager', 'Velachery Manager', 'MANAGER', 'VEL', mgrPw);

if (!get('SELECT 1 FROM offers LIMIT 1')) {
  const adminId = get("SELECT id FROM staff WHERE username = 'admin'").id;
  const offer = (o) =>
    run(
      `INSERT INTO offers(title, description, type, audience, coupon_code, min_spend_paise, value_paise, category, product, bonus_cp, multiplier,
         valid_from, valid_to, max_uses_per_customer, active, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      o.title, o.description, o.type, o.audience || 'GLOBAL', o.coupon || null, (o.min || 0) * 100, (o.value || 0) * 100, o.category || null,
      o.product || null, o.bonus_cp || 0, o.multiplier || null, today, addDays(today, o.days || 30), o.uses || 1, adminId, now,
    );
  offer({ title: '₹100 off on ₹1,500', description: 'Shop for ₹1,500 or more and get ₹100 off your bill.', type: 'SPEND_GET_OFF', min: 1500, value: 100 });
  offer({ title: '₹50 off on Fruits & Vegetables', description: 'On fresh produce purchases of ₹500 or more.', type: 'CATEGORY_OFFER', category: 'Fruits & Vegetables', min: 500, value: 50, uses: 2 });
  offer({ title: 'Double points weekend', description: 'Earn 2× points on every bill above ₹1,000.', type: 'MULTIPLIER', multiplier: 2, min: 1000, uses: 4, days: 14 });
  offer({ title: '10 bonus points on ₹2,000+', description: 'Extra 10 points when you spend ₹2,000 or more.', type: 'BONUS_POINTS', bonus_cp: 1000, min: 2000 });
  offer({ title: 'Birthday treat: ₹150 off', description: 'Happy birthday from Vasantham! ₹150 off on ₹1,000+ during your birthday month.', type: 'BIRTHDAY', min: 1000, value: 150, days: 365 });
}

/* ---------- ecosystem: businesses, partner outlets, managers and rewards ---------- */
const vsm = get('SELECT * FROM businesses WHERE is_program_owner = 1');
run("UPDATE businesses SET category = COALESCE(category, 'Supermarket'), tagline = COALESCE(tagline, 'Redeem points on grocery purchases') WHERE id = ?", vsm.id);
const PARTNERS = [
  { code: 'HOF', name: 'House of Friez', category: 'Food & snacks', tagline: 'Redeem points on food purchases', cycle: 'WEEKLY', sort: 2,
    rule: ['PERCENT', 20, null, 0], outlet: ['HOFANN', 'House of Friez, Anna Nagar', 'hof.manager'] },
  { code: 'AFY', name: 'Afya Mart', category: 'Health & household', tagline: 'Redeem points on eligible purchases', cycle: 'MONTHLY', sort: 3,
    rule: ['PERCENT', 15, null, 0], outlet: ['AFYTNR', 'Afya Mart, T. Nagar', 'afya.manager'] },
  { code: 'MFN', name: 'MF Nuts', category: 'Nuts, seeds & dry fruits', tagline: 'Redeem points on nuts, seeds and related products', cycle: 'MONTHLY', sort: 4,
    rule: ['PERCENT_AND_AMOUNT', 25, 15000, 30000], outlet: ['MFNVEL', 'MF Nuts, Velachery', 'mfn.manager'] },
];
const adminId = get("SELECT id FROM staff WHERE username = 'admin'").id;
for (const p of PARTNERS) {
  let b = get('SELECT * FROM businesses WHERE code = ?', p.code);
  if (!b) {
    const id = run(
      `INSERT INTO businesses(code, name, category, tagline, can_earn, can_redeem, billing_source, settlement_cycle, sort_order, terms, created_by, created_at)
       VALUES (?,?,?,?,0,1,'MANAGER',?,?,?,?,?)`,
      p.code, p.name, p.category, p.tagline, p.cycle, p.sort,
      'Points and rewards are applied before payment. Show the redemption QR to the outlet manager before billing. One redemption per bill.', adminId, now,
    ).lastInsertRowid;
    const [type, pct, maxVal, minBill] = p.rule;
    run('INSERT INTO business_redemption_rules(business_id, limit_type, max_percent, max_value_paise, min_bill_paise, min_points_cp, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id, type, pct, maxVal, minBill, 0, adminId, now);
    b = get('SELECT * FROM businesses WHERE id = ?', id);
  }
  const [code, name, user] = p.outlet;
  if (!get('SELECT 1 FROM branches WHERE code = ?', code)) run('INSERT INTO branches(code, name, city, business_id, created_at) VALUES (?,?,?,?,?)', code, name, 'Chennai', b.id, now);
  staff(user, `${p.name} Manager`, 'MANAGER', code, mgrPw);
}

const bizId = (code) => get('SELECT id FROM businesses WHERE code = ?', code).id;
const reward = (o) => {
  if (get('SELECT 1 FROM offers WHERE title = ? AND business_id = ?', o.title, bizId(o.biz))) return;
  run(
    `INSERT INTO offers(title, description, type, audience, min_spend_paise, value_paise, product, valid_from, valid_to, max_uses_per_customer, active,
       business_id, points_cost_cp, cost_paise, funding_type, funder_business_id, partner_share_paise, terms, created_by, created_at)
     VALUES (?,?,?,'GLOBAL',?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)`,
    o.title, o.description, o.type, (o.min || 0) * 100, o.value * 100, o.product || null, today, addDays(today, 60), o.uses || 1,
    bizId(o.biz), (o.points || 0) * 100, o.cost != null ? o.cost * 100 : null, o.funding || 'PROGRAM', o.funder ? bizId(o.funder) : null, (o.share || 0) * 100,
    o.terms || null, adminId, now,
  );
};
reward({ biz: 'HOF', title: 'Free regular fries', description: 'A regular fries on us with any meal of ₹200 or more.', type: 'FREE_PRODUCT', product: 'Regular fries',
  value: 99, cost: 35, min: 200, funding: 'PARTNER', funder: 'HOF', terms: 'Dine-in or takeaway. One per customer.' });
reward({ biz: 'HOF', title: 'Burger combo for 60 points', description: 'Burger, fries and a drink.', type: 'FREE_PRODUCT', product: 'Burger combo',
  value: 180, cost: 90, points: 60, uses: 3 });
reward({ biz: 'MFN', title: '₹50 off MF Nuts', description: 'On nuts, seeds and dry fruits of ₹400 or more.', type: 'COUPON', value: 50, min: 400 });
reward({ biz: 'AFY', title: 'Free hand wash', description: 'A 200 ml hand wash with any Afya Mart bill of ₹300 or more.', type: 'FREE_PRODUCT', product: 'Hand wash 200ml',
  value: 120, cost: 45, min: 300, funding: 'SHARED', funder: 'AFY', share: 20 });

/* ---------- engagement (Phase 2): interest segments, reward offers, challenges, referrals, reactivation ---------- */
const interest = (code, name, categories, keywords, share) => {
  if (!get('SELECT 1 FROM interest_segments WHERE code = ?', code)) {
    run('INSERT INTO interest_segments(code, name, categories, keywords, min_share, lookback_days, created_at) VALUES (?,?,?,?,?,90,?)', code, name, categories, keywords, share, now);
  }
};
interest('NUTS_HEALTH', 'Nuts, seeds & health foods', 'Dry Fruits & Nuts, Health Foods', 'almond, cashew, pista, walnut, raisin, seeds, oats, millet', 0.12);
interest('SNACKS', 'Snacks, beverages & frozen', 'Snacks, Beverages, Frozen Foods', 'chips, namkeen, cola, juice, frozen, nuggets', 0.2);
interest('HOMECARE', 'Home & personal care', 'Home Care, Personal Care', 'detergent, dishwash, floor cleaner, shampoo, soap', 0.2);

// personalised reward offers (unlocked per customer by milestones, referrals and reactivation)
const personal = (o) => {
  if (get('SELECT 1 FROM offers WHERE title = ? AND business_id = ?', o.title, bizId(o.biz))) return;
  run(
    `INSERT INTO offers(title, description, type, audience, min_spend_paise, value_paise, product, valid_from, valid_to, max_uses_per_customer, active,
       business_id, points_cost_cp, cost_paise, funding_type, funder_business_id, target_segments, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,1,?,0,?,?,?,?,?,?)`,
    o.title, o.description, o.type, o.audience || 'PERSONAL', (o.min || 0) * 100, o.value * 100, o.product || null, today, addDays(today, 365),
    bizId(o.biz), o.cost != null ? o.cost * 100 : null, o.funding || 'PROGRAM', o.funder ? bizId(o.funder) : null, o.target || null, adminId, now,
  );
};
personal({ biz: 'HOF', title: '₹50 House of Friez reward', description: '₹50 off your House of Friez bill of ₹200 or more.', type: 'COUPON', value: 50, min: 200 });
personal({ biz: 'MFN', title: 'MF Nuts ₹75 coupon', description: '₹75 off nuts, seeds and dry fruits of ₹400 or more.', type: 'COUPON', value: 75, min: 400 });
personal({ biz: 'AFY', title: 'Afya Mart free wellness pack', description: 'A free wellness pack with any Afya Mart bill of ₹300 or more.', type: 'FREE_PRODUCT', product: 'Wellness pack', value: 150, cost: 60, min: 300 });
personal({ biz: 'HOF', title: 'Welcome: free fries at House of Friez', description: 'A regular fries on us, welcome to Vasantham Rewards!', type: 'FREE_PRODUCT', product: 'Regular fries', value: 99, cost: 35, funding: 'PARTNER', funder: 'HOF' });
personal({ biz: 'VSM', title: 'We miss you: ₹75 off', description: '₹75 off your next Vasantham bill of ₹750 or more.', type: 'PERSONAL_DISCOUNT', value: 75, min: 750 });
// cross-business offers shown only to matching interest segments
personal({ biz: 'MFN', audience: 'GLOBAL', target: 'INT:NUTS_HEALTH', title: 'For nut lovers: ₹60 off at MF Nuts', description: 'Because you love healthy snacking. On bills of ₹500 or more.', type: 'COUPON', value: 60, min: 500 });
personal({ biz: 'HOF', audience: 'GLOBAL', target: 'INT:SNACKS', title: 'Snack fans: free dip at House of Friez', description: 'A free dip with any fries.', type: 'FREE_PRODUCT', product: 'Dip', value: 40, cost: 12, funding: 'PARTNER', funder: 'HOF' });
personal({ biz: 'AFY', audience: 'GLOBAL', target: 'INT:HOMECARE', title: '10% value back at Afya Mart', description: '₹50 off home-care and wellness bills of ₹500 or more.', type: 'COUPON', value: 50, min: 500 });

const offerId = (title) => get('SELECT id FROM offers WHERE title = ?', title).id;
const monthStart = `${today.slice(0, 7)}-01`;
const challenge = (c, tiers) => {
  if (get('SELECT 1 FROM challenges WHERE name = ?', c.name)) return;
  const id = run(
    `INSERT INTO challenges(name, description, type, period, business_id, min_bill_paise, valid_from, valid_to, repeatable, active, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,1,0,?,?)`, // created OFF: review in Admin → Milestones & challenges, then activate
    c.name, c.description, c.type, c.period, vsm.id, (c.min || 0) * 100, monthStart, addDays(monthStart, 365), adminId, now,
  ).lastInsertRowid;
  for (const [threshold, type, pointsOrOffer] of tiers) {
    run('INSERT INTO challenge_tiers(challenge_id, threshold, reward_type, reward_cp, reward_offer_id, reward_valid_days) VALUES (?,?,?,?,?,30)',
      id, threshold, type, type === 'POINTS' ? pointsOrOffer * 100 : 0, type === 'OFFER' ? offerId(pointsOrOffer) : null);
  }
};
challenge({ name: 'Monthly Spend Challenge', description: 'Shop at Vasantham this month and unlock rewards across the family of stores.', type: 'SPEND', period: 'MONTHLY' }, [
  [250000, 'POINTS', 10], [500000, 'OFFER', '₹50 House of Friez reward'], [750000, 'OFFER', 'MF Nuts ₹75 coupon'], [1000000, 'OFFER', 'Afya Mart free wellness pack'],
]);
challenge({ name: 'Visit Vasantham 4 times this month', description: 'Four shopping trips this month earn you 20 bonus points.', type: 'VISITS', period: 'MONTHLY', min: 300 }, [[4, 'POINTS', 20]]);

if (!get('SELECT 1 FROM referral_programs')) {
  run(
    `INSERT INTO referral_programs(name, active, valid_from, valid_to, min_purchase_paise, qualify_days, referrer_reward_type, referrer_cp, referee_reward_type, referee_offer_id,
       reward_valid_days, max_referrals, max_per_day, new_customer_days, created_by, created_at) VALUES ('Refer a friend',0,?,?,50000,30,'POINTS',2500,'OFFER',?,30,10,3,30,?,?)`, // OFF until reviewed
    today, addDays(today, 365), offerId('Welcome: free fries at House of Friez'), adminId, now,
  );
}
if (!get('SELECT 1 FROM automations')) {
  // created switched OFF: review it in Admin → Reactivation before activating
  run(`INSERT INTO automations(name, segment, offer_id, reward_valid_days, cooldown_days, window_days, message, active, created_by, created_at)
       VALUES ('Win back overdue shoppers','OVERDUE',?,14,60,30,'We miss you! Here is ₹75 off your next Vasantham visit.',0,?,?)`, offerId('We miss you: ₹75 off'), adminId, now);
  run(`INSERT INTO automations(name, segment, offer_id, reward_valid_days, cooldown_days, window_days, message, active, created_by, created_at)
       VALUES ('Dormant: treat at House of Friez','DORMANT',?,21,90,30,'A treat from House of Friez, on us. Come back and see what is new.',0,?,?)`, offerId('₹50 House of Friez reward'), adminId, now);
}

console.log('Seed complete.');
if (created.length) {
  console.log('\nLogins created (change these passwords before going live):');
  console.log(created.join('\n'));
}
