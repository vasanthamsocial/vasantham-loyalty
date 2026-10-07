// Generates a realistic sample POS export (item level, 90 days, 3 branches) for demos:
//   npm run sample   →  samples/sample-pos-export.xlsx
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { CONFIG } from '../src/config.js';
import { TEMPLATE_HEADERS } from '../src/importer.js';

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const PRODUCTS = [
  ['P100', 'Ponni Rice 5kg', 'Grocery', 420], ['P101', 'Basmati Rice 1kg', 'Grocery', 160], ['P102', 'Toor Dal 1kg', 'Grocery', 175],
  ['P103', 'Sunflower Oil 1L', 'Grocery', 155], ['P104', 'Wheat Atta 5kg', 'Grocery', 265], ['P105', 'Sugar 1kg', 'Grocery', 48],
  ['P200', 'Tomato 1kg', 'Fruits & Vegetables', 40], ['P201', 'Onion 1kg', 'Fruits & Vegetables', 45], ['P202', 'Banana (dozen)', 'Fruits & Vegetables', 60],
  ['P203', 'Apple 1kg', 'Fruits & Vegetables', 180], ['P300', 'Milk 500ml', 'Dairy', 28], ['P301', 'Curd 400g', 'Dairy', 40], ['P302', 'Paneer 200g', 'Dairy', 95],
  ['P400', 'Detergent 1kg', 'Home Care', 210], ['P401', 'Dishwash Liquid', 'Home Care', 110], ['P500', 'Shampoo 180ml', 'Personal Care', 165],
  ['P501', 'Toothpaste 150g', 'Personal Care', 99], ['P600', 'Biscuits Family Pack', 'Snacks', 70], ['P601', 'Namkeen 400g', 'Snacks', 90], ['P700', 'Filter Coffee 500g', 'Beverages', 290],
  ['P800', 'Almonds 250g', 'Dry Fruits & Nuts', 260], ['P801', 'Cashew 200g', 'Dry Fruits & Nuts', 240], ['P802', 'Chia Seeds 200g', 'Health Foods', 180],
  ['P900', 'Frozen Nuggets 400g', 'Frozen Foods', 210], ['P701', 'Orange Juice 1L', 'Beverages', 120],
];
const BRANCHES = ['ANN', 'TNR', 'VEL'];
const NAMES = ['Priya', 'Karthik', 'Lakshmi', 'Suresh', 'Divya', 'Arun', 'Meena', 'Vijay', 'Anitha', 'Ramesh', 'Kavya', 'Senthil', 'Deepa', 'Ganesh', 'Revathi'];

const customers = Array.from({ length: 160 }, (_, i) => ({
  mobile: `98${String(40000000 + i * 7919).slice(0, 8)}`,
  name: `${pick(NAMES)} ${String.fromCharCode(65 + (i % 26))}`,
  branch: pick(BRANCHES),
  // behaviour: some frequent, some weekly, some lapsed
  every: pick([3, 5, 7, 7, 10, 14, 21, 30]),
  stopAfter: rnd() < 0.2 ? int(20, 60) : 999, // 20% stop shopping (become dormant/lost)
  weekend: rnd() < 0.2,
}));

const today = new Date(Date.now() + CONFIG.timezoneOffsetMin * 60000);
const days = 90;
const rows = [TEMPLATE_HEADERS];
let billNo = 100000;
const ddmmyyyy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
const sales = [];

for (let dOff = days; dOff >= 1; dOff--) {
  const d = new Date(today.getTime() - dOff * 86400000);
  const dow = d.getUTCDay();
  const date = ddmmyyyy(d);
  const shoppers = customers.filter((c, i) => days - dOff < c.stopAfter && (i + dOff) % c.every === 0 && (!c.weekend || dow === 0 || dow === 6));
  const walkins = int(8, 20);
  for (const c of [...shoppers, ...Array(walkins).fill(null)]) {
    const branch = c ? (rnd() < 0.8 ? c.branch : pick(BRANCHES)) : pick(BRANCHES);
    const bill = `${branch}-${++billNo}`;
    const items = Array.from({ length: int(2, 9) }, () => {
      const [code, name, cat, rate] = pick(PRODUCTS);
      const qty = int(1, 3);
      const disc = rnd() < 0.25 ? Math.round(rate * qty * 0.1) : 0;
      return { code, name, cat, rate, qty, disc, amount: rate * qty - disc };
    });
    const gross = items.reduce((s, i) => s + i.rate * i.qty, 0);
    const disc = items.reduce((s, i) => s + i.disc, 0);
    const net = gross - disc;
    const time = `${String(int(9, 21)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}`;
    for (const it of items) {
      rows.push([bill, date, time, branch, c ? c.mobile : '', '', c ? c.name : '', gross, disc, net, '', '', 'SALE', '', it.code, it.name, it.cat, it.qty, it.rate, it.disc, it.amount]);
    }
    if (c) sales.push({ bill, date, time, branch, c, net, gross });
  }
}
// a few returns against earlier bills
for (let i = 0; i < 6; i++) {
  const s = pick(sales);
  const part = Math.round(s.net * 0.3);
  rows.push([`${s.bill}-R`, s.date, s.time, s.branch, s.c.mobile, '', s.c.name, part, 0, part, '', '', 'RETURN', s.bill, '', '', '', '', '', '', '']);
}

const outDir = path.join(CONFIG.root, 'samples');
fs.mkdirSync(outDir, { recursive: true });
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Bills');
const out = path.join(outDir, 'sample-pos-export.xlsx');
fs.writeFileSync(out, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
console.log(`Wrote ${rows.length - 1} rows (${sales.length} member bills) to ${out}`);
