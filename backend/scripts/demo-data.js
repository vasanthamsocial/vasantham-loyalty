// Demo data for the ecosystem: customers + purchases (sample Excel) and redemptions across businesses.
//   npm run seed && npm run demo
// Safe to re-run: the Excel import skips duplicate bills, and redemptions are only added once.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONFIG } from '../src/config.js';
import { all, get, run, tx } from '../src/db.js';
import { importWorkbook } from '../src/importer.js';
import { approve, confirmPartnerBill, createRequest, markSubmitted } from '../src/redemptions.js';
import { hashPassword } from '../src/auth.js';

const admin = get("SELECT * FROM staff WHERE username = 'admin'");
if (!admin || !get("SELECT 1 FROM businesses WHERE code = 'HOF'")) {
  console.log('Run "npm run seed" first.');
  process.exit(1);
}

// demo only: switch on the seeded challenges and referral programme (seed creates them OFF)
run("UPDATE challenges SET active = 1 WHERE name IN ('Monthly Spend Challenge', 'Visit Vasantham 4 times this month')");
run("UPDATE referral_programs SET active = 1 WHERE name = 'Refer a friend'");

// demo only: one login per Phase 3 role (password Demo@12345). Not created by the seed, so the
// live database never gets extra accounts with a known password.
const demoLogin = (username, name, accessRole, role, { branch = null, business = null } = {}) => {
  if (get('SELECT 1 FROM staff WHERE username = ?', username)) return;
  run('INSERT INTO staff(username, name, role, access_role, branch_id, business_id, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?)',
    username, name, role, accessRole, branch ? get('SELECT id FROM branches WHERE code = ?', branch).id : null,
    business ? get('SELECT id FROM businesses WHERE code = ?', business).id : null, hashPassword('Demo@12345'), new Date().toISOString());
  console.log(`  demo login ${username.padEnd(16)} ${accessRole}`);
};
demoLogin('vasantham.admin', 'Vasantham Ops Admin', 'VASANTHAM_ADMIN', 'ADMIN');
demoLogin('hof.owner', 'House of Friez Owner', 'BUSINESS_ADMIN', 'ADMIN', { business: 'HOF' });
demoLogin('reports', 'Reporting User', 'REPORTING', 'ADMIN');
demoLogin('hof.cashier', 'HOF Redemption Desk', 'REDEMPTION_MANAGER', 'MANAGER', { branch: 'HOFANN' });

const sample = path.join(CONFIG.root, 'samples', 'sample-pos-export.xlsx');
if (!fs.existsSync(sample)) execFileSync(process.execPath, [path.join(CONFIG.root, 'scripts', 'make-sample-excel.js')], { stdio: 'inherit' });
if (!get("SELECT 1 FROM imports WHERE filename = 'sample-pos-export.xlsx' AND status LIKE 'COMPLETED%'")) {
  const r = importWorkbook(fs.readFileSync(sample), { filename: 'sample-pos-export.xlsx', staff: admin, force: true });
  console.log(`Imported sample bills: ${r.imported} bills, ${r.newCustomers} customers, ${(r.creditedCp / 100).toFixed(2)} points`);
}

if (get("SELECT 1 FROM redemptions WHERE requested_via = 'DEMO'")) {
  console.log('Demo redemptions already exist.');
  process.exit(0);
}

const manager = (username) => get(
  `SELECT s.*, b.name branch_name FROM staff s JOIN branches b ON b.id = s.branch_id WHERE s.username = ?`, username,
);
const offer = (title) => get('SELECT * FROM offers WHERE title = ?', title);
const customers = all("SELECT * FROM customers WHERE balance_cp >= 6000 AND status = 'ACTIVE' ORDER BY balance_cp DESC LIMIT 12");
if (customers.length < 6) {
  console.log('Not enough customers with points for the demo.');
  process.exit(0);
}

let n = 0;
function redeem(c, mgr, { kind, points, offerTitle, bill, billNo }) {
  const m = manager(mgr);
  const biz = get('SELECT * FROM businesses WHERE id = (SELECT business_id FROM branches WHERE id = ?)', m.branch_id);
  try {
    tx(() => {
      const o = offerTitle ? offer(offerTitle) : null;
      const req = createRequest({ customerId: c.id, kind, cp: kind === 'POINTS' ? Math.round(points * 100) : 0, offerId: o?.id, via: 'DEMO', branchId: m.branch_id });
      const r = approve(req.id, m, '127.0.0.1', { billPaise: bill != null ? bill * 100 : null, cp: kind === 'POINTS' ? Math.round(points * 100) : null });
      if (billNo && biz.billing_source === 'MANAGER') confirmPartnerBill(r.id, m, { billNo, billPaise: bill * 100 }, '127.0.0.1');
      else markSubmitted(r.id, m);
    });
    n++;
  } catch (e) {
    console.log(`  skipped (${c.mobile} at ${biz.name}): ${e.message}`);
  }
}

const [a, b, c, d, e, f] = customers;
redeem(a, 'hof.manager', { kind: 'POINTS', points: 40, bill: 450, billNo: 'HOF-5001' }); // 20% of ₹450 = ₹90 = 45 pts max
redeem(b, 'hof.manager', { kind: 'OFFER', offerTitle: 'Free regular fries', bill: 320, billNo: 'HOF-5002' });
redeem(c, 'hof.manager', { kind: 'OFFER', offerTitle: 'Burger combo for 60 points', bill: 260, billNo: 'HOF-5003' });
redeem(d, 'mfn.manager', { kind: 'POINTS', points: 50, bill: 800, billNo: 'MFN-7001' }); // 25% of ₹800 = ₹200, capped at ₹150
redeem(e, 'mfn.manager', { kind: 'OFFER', offerTitle: '₹50 off MF Nuts', bill: 650, billNo: 'MFN-7002' });
redeem(f, 'afya.manager', { kind: 'OFFER', offerTitle: 'Free hand wash', bill: 540, billNo: 'AFY-3001' });
redeem(a, 'afya.manager', { kind: 'POINTS', points: 20, bill: 700 }); // approved, bill not yet confirmed
redeem(b, 'ann.manager', { kind: 'POINTS', points: 25 }); // at Vasantham, reconciled by the next Excel upload
console.log(`Created ${n} demo redemptions across Vasantham, House of Friez, MF Nuts and Afya Mart.`);
console.log('See Admin → Settlements, Admin → Redemption monitor, and the Rewards tab in the Customer App.');
