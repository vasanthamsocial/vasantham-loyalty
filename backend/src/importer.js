import * as XLSX from 'xlsx';
import { all, get, run, tx } from './db.js';
import { autoOfferPoints } from './offers.js';
import { postLedger } from './points.js';
import { findOrCreateByMobile } from './customers.js';
import { extractRefs, reconcileBill } from './reconcile.js';
import { recomputeSegments } from './segments.js';
import { afterPurchases } from './engagement.js';
import { rebuildActivity } from './growth.js';
import { audit, notify } from './audit.js';
import { businessOfBranch } from './businesses.js';
import { bad, earnCentipoints, fmtPoints, fmtRupees, normMobile, nowIso, rawPoints, sha256, toPaise } from './util.js';

/* Accepted column names (compared after lower-casing and removing non-alphanumerics). */
export const FIELDS = {
  bill_no: ['billno', 'billnumber', 'invoiceno', 'invoicenumber', 'billnum', 'invno'],
  bill_date: ['billdate', 'date', 'invoicedate'],
  bill_time: ['billtime', 'time', 'invoicetime'],
  branch: ['branch', 'branchcode', 'branchname', 'store', 'storecode', 'outlet'],
  mobile: ['mobile', 'mobileno', 'mobilenumber', 'customermobile', 'customermobileno', 'phone', 'phoneno', 'contactno'],
  customer_code: ['customercode', 'customerid', 'custcode', 'custid', 'loyaltyid', 'membercode'],
  customer_name: ['customername', 'custname'],
  bill_value: ['billvalue', 'finalbillvalue', 'grossvalue', 'grossamount', 'billamount', 'totalamount'],
  discount: ['discount', 'billdiscount', 'totaldiscount', 'discountamount'],
  net_value: ['netvalue', 'neteligiblevalue', 'eligiblevalue', 'netamount', 'paidvalue', 'netbillvalue', 'paidamount'],
  loyalty_ref: ['loyaltyref', 'loyaltyreference', 'redemptionid', 'redemptionref', 'remarks', 'billremarks', 'narration'],
  loyalty_discount: ['loyaltydiscount', 'loyaltyamount', 'redemptionamount', 'loyaltyvalue', 'rewarddiscount'],
  bill_type: ['billtype', 'type', 'transactiontype', 'txntype'],
  original_bill_no: ['originalbillno', 'refbillno', 'returnagainst', 'originalinvoiceno', 'againstbillno'],
  product: ['product', 'productname', 'itemname', 'item'],
  product_code: ['productcode', 'itemcode', 'sku', 'barcode'],
  category: ['category', 'productcategory', 'itemcategory', 'department', 'dept'],
  qty: ['qty', 'quantity'],
  rate: ['rate', 'price', 'unitprice', 'mrp'],
  item_discount: ['itemdiscount', 'discountperitem', 'linediscount'],
  item_amount: ['itemamount', 'amount', 'linetotal', 'lineamount', 'itemvalue'],
  points: ['points', 'point', 'pts', 'loyaltypoints', 'pointsearned', 'earnedpoints', 'rewardpoints', 'billpoints', 'totalpoints'],
};

/**
 * How points are worked out for an upload:
 *  AMOUNT — from the net eligible value (₹200 = 1 point) plus automatic bonus / multiplier offers.
 *  POINTS — the file's Points column is credited exactly as given (the POS already calculated them);
 *           no automatic offers are added on top, so nothing is counted twice.
 */
export const CALC_MODES = ['AMOUNT', 'POINTS'];

const POINTS_HEADERS = [
  'Bill No', 'Bill Date', 'Bill Time', 'Branch', 'Customer Mobile', 'Customer Code', 'Customer Name',
  'Net Eligible Value', 'Points', 'Loyalty Ref', 'Loyalty Discount', 'Bill Type', 'Original Bill No',
];

export const TEMPLATE_HEADERS = [
  'Bill No', 'Bill Date', 'Bill Time', 'Branch', 'Customer Mobile', 'Customer Code', 'Customer Name',
  'Bill Value', 'Discount', 'Net Eligible Value', 'Loyalty Ref', 'Loyalty Discount', 'Bill Type', 'Original Bill No',
  'Product Code', 'Product', 'Category', 'Qty', 'Rate', 'Item Discount', 'Item Amount',
];

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

function mapHeaders(headers) {
  const map = {};
  const lookup = {};
  for (const [f, names] of Object.entries(FIELDS)) for (const n of names) lookup[n] = f;
  for (const h of headers) {
    const f = lookup[norm(h)];
    if (f && !map[f]) map[f] = h;
  }
  return map;
}

/** Returns { date: 'YYYY-MM-DD', time: 'HH:MM' | null } or null. Day-first for ambiguous strings (Indian format). */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d || d.y < 2000) return null;
    const time = v % 1 ? `${pad(d.H)}:${pad(d.M)}` : null;
    return { date: `${d.y}-${pad(d.m)}-${pad(d.d)}`, time };
  }
  const s = String(v).trim();
  let m;
  let y, mo, d;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) [, y, mo, d] = m;
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) [, d, mo, y] = m;
  else if ((m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ,]+(\d{2,4})/.exec(s))) {
    [, d, mo, y] = m;
    mo = MONTHS[mo.toLowerCase()];
  } else return null;
  y = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  mo = Number(mo);
  d = Number(d);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const tm = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/.exec(s.slice(8));
  return { date: `${y}-${pad(mo)}-${pad(d)}`, time: tm ? parseTime(tm[0]) : null };
}

export function parseTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const mins = Math.round((v % 1) * 1440);
    return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
  }
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/.exec(String(v));
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) {
    const pm = m[3].toLowerCase() === 'pm';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return `${pad(h)}:${m[2]}`;
}

function billType(v, netPaise) {
  const s = String(v || '').toUpperCase();
  if (/CANC|VOID/.test(s)) return 'CANCELLED';
  if (/RET|REFUND|CREDIT/.test(s)) return 'RETURN';
  if (!s && netPaise < 0) return 'RETURN';
  return 'SALE';
}

/** Points cell -> centipoints, truncated to 2 decimals like the earning rule. Blank -> null; not a number -> NaN. */
function pointsCp(v) {
  if (v === null || v === undefined || v === '') return null;
  const str = typeof v === 'number' ? null : String(v).replace(/[,\s]/g, '');
  if (str === '') return null;
  const n = str === null ? v : Number(str);
  if (!Number.isFinite(n)) return NaN;
  return Math.sign(n) * Math.floor(Math.abs(n) * 100 + 1e-6);
}

const text = (v) => (v === null || v === undefined ? null : String(typeof v === 'number' && Number.isInteger(v) ? v : v).trim() || null);

/**
 * Parse + validate + process one uploaded workbook.
 * Valid bills are imported; invalid or duplicate bills are reported and skipped.
 */
export function importWorkbook(buffer, { filename, staff, defaultBranchId = null, force = false, ip = null, mode = 'AMOUNT' }) {
  if (!CALC_MODES.includes(mode)) throw bad('Choose how points are calculated: from amount or from the Points column');
  const byPoints = mode === 'POINTS';
  if (!buffer?.length) throw bad('The uploaded file is empty');
  const hash = sha256(buffer.toString('base64'));
  const prev = get("SELECT id, uploaded_at FROM imports WHERE file_hash = ? AND status LIKE 'COMPLETED%'", hash);
  if (prev && !force) throw bad(`This exact file was already imported (upload #${prev.id}). Duplicate upload rejected.`);

  let rows;
  try {
    // raw: keep CSV text as-is so dates like 03-09-2026 are parsed day-first by us, not guessed
    const wb = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: false, dense: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true, blankrows: false });
  } catch (e) {
    throw bad(`Could not read the file as Excel/CSV: ${e.message}`);
  }
  if (!rows.length) throw bad('No data rows found in the first sheet');

  const col = mapHeaders(Object.keys(rows[0]).concat(...rows.slice(1, 5).map(Object.keys)));
  const missing = [];
  if (!col.bill_no) missing.push('Bill No');
  if (!col.bill_date) missing.push('Bill Date');
  if (byPoints && !col.points) missing.push('Points (this upload is set to "Points given in file")');
  if (!byPoints && !col.net_value && !col.bill_value && !col.item_amount) missing.push('Net Eligible Value');
  if (!col.branch && !defaultBranchId) missing.push('Branch (or choose a branch for this file)');
  if (missing.length) throw bad(`Missing required column(s): ${missing.join(', ')}`, { found: Object.keys(rows[0]) });

  const branches = all('SELECT id, code, name FROM branches');
  const branchBy = new Map();
  for (const b of branches) {
    branchBy.set(b.code.toLowerCase(), b.id);
    branchBy.set(b.name.toLowerCase(), b.id);
  }

  const importId = Number(
    run('INSERT INTO imports(filename, file_hash, uploaded_by, uploaded_at, status, rows_total, calc_mode) VALUES (?,?,?,?,?,?,?)',
      filename || 'upload.xlsx', hash, staff.id, nowIso(), 'PROCESSING', rows.length, mode).lastInsertRowid,
  );
  const errors = [];
  const err = (rowNo, billNo, message, level = 'ERROR') => errors.push({ rowNo, billNo, message, level });
  const g = (r, f) => (col[f] ? r[col[f]] : null);

  /* ---- 1. validate rows & group into bills ---- */
  const bills = new Map();
  rows.forEach((r, i) => {
    const rowNo = i + 2; // header is row 1
    const billNo = text(g(r, 'bill_no'));
    const dt = parseDate(g(r, 'bill_date'));
    const branchRaw = text(g(r, 'branch'));
    const branchId = branchRaw ? branchBy.get(branchRaw.toLowerCase()) : defaultBranchId;
    if (!billNo) return err(rowNo, null, 'Bill number is missing');
    if (!dt) return err(rowNo, billNo, `Invalid bill date "${g(r, 'bill_date') ?? ''}"`);
    if (!branchId) return err(rowNo, billNo, `Unknown branch "${branchRaw ?? ''}". Add it under Branches first.`);

    const net = toPaise(g(r, 'net_value'));
    const type = billType(g(r, 'bill_type'), net ?? 0);
    const key = `${branchId}|${billNo}|${dt.date}|${type}`;
    let b = bills.get(key);
    if (!b) {
      b = {
        rowNo, billNo, branchId, type, date: dt.date,
        time: parseTime(g(r, 'bill_time')) || dt.time,
        mobileRaw: text(g(r, 'mobile')),
        codeRaw: text(g(r, 'customer_code')),
        name: text(g(r, 'customer_name')),
        billValue: toPaise(g(r, 'bill_value')),
        discount: toPaise(g(r, 'discount')),
        net,
        points: byPoints ? pointsCp(g(r, 'points')) : null,
        loyaltyDiscount: col.loyalty_discount ? toPaise(g(r, 'loyalty_discount')) : undefined,
        refText: text(g(r, 'loyalty_ref')),
        originalBillNo: text(g(r, 'original_bill_no')),
        items: [],
      };
      bills.set(key, b);
    } else {
      // item-level files repeat bill fields on every row; fill any gaps
      b.net ??= net;
      if (byPoints) b.points ??= pointsCp(g(r, 'points'));
      b.mobileRaw ??= text(g(r, 'mobile'));
      b.codeRaw ??= text(g(r, 'customer_code'));
      const ref = text(g(r, 'loyalty_ref'));
      if (ref && !(b.refText || '').includes(ref)) b.refText = [b.refText, ref].filter(Boolean).join(' ');
      if (b.loyaltyDiscount == null && col.loyalty_discount) b.loyaltyDiscount = toPaise(g(r, 'loyalty_discount'));
    }
    if (col.product || col.product_code || col.item_amount) {
      const it = {
        product_code: text(g(r, 'product_code')),
        product_name: text(g(r, 'product')),
        category: text(g(r, 'category')),
        qty: Number(g(r, 'qty')) || null,
        rate_paise: toPaise(g(r, 'rate')),
        discount_paise: toPaise(g(r, 'item_discount')),
        amount_paise: toPaise(g(r, 'item_amount')),
      };
      if (it.product_code || it.product_name || it.amount_paise) b.items.push(it);
    }
  });

  /* ---- 2. process bills (sales before returns / cancellations) ---- */
  const order = { SALE: 0, RETURN: 1, CANCELLED: 2 };
  const list = [...bills.values()].sort((a, b) => order[a.type] - order[b.type] || a.date.localeCompare(b.date));
  const stats = { imported: 0, duplicate: 0, error: 0, items: 0, newCustomers: 0, creditedCp: 0, reversedCp: 0, reconciled: 0, issues: 0, minDate: null, maxDate: null };
  const actor = { type: 'SYSTEM', id: staff.id };
  const touched = new Set();
  const billDates = new Map(); // customerId → bill dates, for challenges / referrals
  const bizCache = new Map();
  const earnBiz = (branchId) => {
    if (!bizCache.has(branchId)) bizCache.set(branchId, businessOfBranch(branchId));
    return bizCache.get(branchId);
  };

  for (const b of list) {
    try {
      tx(() => processBill(b));
    } catch (e) {
      stats.error++;
      err(b.rowNo, b.billNo, e.message);
    }
  }

  function processBill(b) {
    if (get('SELECT 1 FROM purchases WHERE branch_id = ? AND bill_no = ? AND bill_date = ? AND bill_type = ?', b.branchId, b.billNo, b.date, b.type)) {
      stats.duplicate++;
      err(b.rowNo, b.billNo, 'Duplicate bill — already imported earlier; skipped', 'WARN');
      return;
    }
    if (b.net == null && b.items.length) b.net = b.items.reduce((s, it) => s + (it.amount_paise || 0), 0);
    if (b.net == null) b.net = b.billValue != null && b.discount != null ? b.billValue - b.discount : b.billValue;
    if (b.net == null && byPoints) b.net = 0; // amount is optional when the POS gives points
    if (b.net == null) throw new Error('Net eligible value is missing');
    if (Number.isNaN(b.points)) throw new Error('Points is not a number');
    if (byPoints && b.type === 'SALE' && b.points < 0) throw new Error('Points cannot be negative on a sale bill');
    const netAbs = Math.abs(b.net);
    const discount = Math.abs(b.discount ?? 0);
    const billValue = Math.abs(b.billValue ?? netAbs + discount);

    // --- customer matching: mobile first, then customer code / POS code ---
    const mobile = normMobile(b.mobileRaw);
    if (b.mobileRaw && !mobile) err(b.rowNo, b.billNo, `Invalid mobile "${b.mobileRaw}" — bill imported as non-member`, 'WARN');
    let customer = null;
    if (mobile) {
      const r = findOrCreateByMobile(mobile, { name: b.name, via: 'POS', branchId: b.branchId, posCode: b.codeRaw });
      customer = r.customer;
      if (r.created) stats.newCustomers++;
    } else if (b.codeRaw) {
      customer = get('SELECT * FROM customers WHERE code = ? OR pos_customer_code = ?', b.codeRaw.toUpperCase(), b.codeRaw);
      if (!customer) err(b.rowNo, b.billNo, `Customer code "${b.codeRaw}" not found and no mobile given — imported as non-member`, 'WARN');
    }
    if (customer) {
      if (b.codeRaw && !customer.pos_customer_code && b.codeRaw.toUpperCase() !== customer.code) run('UPDATE customers SET pos_customer_code = ? WHERE id = ?', b.codeRaw, customer.id);
      if (b.name && !customer.name) run('UPDATE customers SET name = ? WHERE id = ?', b.name, customer.id);
    }

    // --- original bill (returns / cancellations) ---
    let orig = null;
    if (b.type !== 'SALE') {
      const origNo = b.originalBillNo || b.billNo;
      orig = get("SELECT * FROM purchases WHERE branch_id = ? AND bill_no = ? AND bill_type = 'SALE' ORDER BY bill_date DESC LIMIT 1", b.branchId, origNo);
      if (!customer && orig?.customer_id) customer = get('SELECT * FROM customers WHERE id = ?', orig.customer_id);
      if (!orig) err(b.rowNo, b.billNo, `Original bill "${origNo}" not found — points reversed at the standard rate`, 'WARN');
    }

    const refs = extractRefs(b.refText);
    const pid = Number(
      run(
        `INSERT INTO purchases(branch_id, bill_no, bill_date, bill_time, bill_type, original_bill_no, original_purchase_id, customer_id, mobile_raw, customer_code_raw,
           bill_value_paise, discount_paise, net_paise, loyalty_discount_paise, loyalty_ref, raw_points, import_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        b.branchId, b.billNo, b.date, b.time, b.type, b.originalBillNo, orig?.id ?? null, customer?.id ?? null, b.mobileRaw, b.codeRaw,
        billValue, discount, netAbs, b.loyaltyDiscount === undefined ? null : b.loyaltyDiscount != null ? Math.abs(b.loyaltyDiscount) : null,
        refs.join(' ') || b.refText, b.type !== 'SALE' ? 0 : byPoints ? (b.points ?? 0) / 100 : rawPoints(netAbs), importId, nowIso(),
      ).lastInsertRowid,
    );
    for (const it of b.items) {
      run('INSERT INTO purchase_items(purchase_id, product_code, product_name, category, qty, rate_paise, discount_paise, amount_paise) VALUES (?,?,?,?,?,?,?,?)',
        pid, it.product_code, it.product_name, it.category, it.qty, it.rate_paise, it.discount_paise, it.amount_paise);
      stats.items++;
    }
    const branchName = get('SELECT name FROM branches WHERE id = ?', b.branchId).name;
    const biz = earnBiz(b.branchId);
    if (customer && b.type === 'SALE' && !biz.can_earn) err(b.rowNo, b.billNo, `${biz.name} does not earn loyalty points — bill recorded without points`, 'WARN');

    // --- points ---
    if (customer && b.type === 'SALE' && biz.can_earn) {
      if (byPoints && b.points == null) throw new Error('Points missing for a member bill (enter 0 if the bill earns no points)');
      const base = byPoints ? b.points : earnCentipoints(netAbs);
      let total = base;
      const what = netAbs ? `Purchase ${fmtRupees(netAbs)}` : 'Purchase';
      if (base > 0 || !byPoints) postLedger({ customerId: customer.id, type: 'EARN', cp: base, branchId: b.branchId, purchaseId: pid, note: `${what} · Bill ${b.billNo}`, actor });
      if (!byPoints) for (const a of autoOfferPoints({ customer, branchId: b.branchId, billDate: b.date, netPaise: netAbs, items: b.items, baseCp: base })) {
        postLedger({ customerId: customer.id, type: 'BONUS', cp: a.cp, branchId: b.branchId, purchaseId: pid, offerId: a.offer.id, note: `${a.offer.title} · Bill ${b.billNo}`, actor });
        total += a.cp;
      }
      run('UPDATE purchases SET credited_cp = ? WHERE id = ?', total, pid);
      run(
        `UPDATE customers SET
           first_purchase_date = CASE WHEN first_purchase_date IS NULL OR first_purchase_date > ? THEN ? ELSE first_purchase_date END,
           last_purchase_date  = CASE WHEN last_purchase_date  IS NULL OR last_purchase_date  < ? THEN ? ELSE last_purchase_date END
         WHERE id = ?`,
        b.date, b.date, b.date, b.date, customer.id,
      );
      stats.creditedCp += total;
      if (total > 0) notify(customer.id, 'POINTS_EARNED', `+${fmtPoints(total)} points earned`, `${netAbs ? `Purchase of ${fmtRupees(netAbs)}` : `Bill ${b.billNo}`} at ${branchName} on ${b.date}.`);
    } else if (customer && b.type !== 'SALE' && biz.can_earn) {
      let rev;
      const given = byPoints && b.points != null ? Math.abs(b.points) : null; // points to take back, as stated by the POS
      if (orig) {
        const remaining = orig.credited_cp - orig.reversed_cp;
        rev = b.type === 'CANCELLED' ? remaining
          : given != null ? Math.min(remaining, given)
            : Math.min(remaining, Math.floor((orig.credited_cp * Math.min(netAbs, orig.net_paise)) / (orig.net_paise || 1)));
        run('UPDATE purchases SET reversed_cp = reversed_cp + ? WHERE id = ?', rev, orig.id);
      } else {
        rev = given ?? earnCentipoints(netAbs);
      }
      if (rev > 0) {
        postLedger({ customerId: customer.id, type: 'RETURN_REVERSAL', cp: -rev, branchId: b.branchId, purchaseId: pid,
          note: `${b.type === 'CANCELLED' ? 'Bill cancelled' : 'Return'}${netAbs ? ` ${fmtRupees(netAbs)}` : ''} · Bill ${b.billNo}`, actor });
        stats.reversedCp += rev;
      }
    }
    if (customer) {
      touched.add(customer.id);
      if (!billDates.has(customer.id)) billDates.set(customer.id, new Set());
      billDates.get(customer.id).add(b.date);
    }

    // --- reconciliation of redemptions used on this bill ---
    const p = get('SELECT * FROM purchases WHERE id = ?', pid);
    const rc = reconcileBill(p, refs, importId);
    stats.reconciled += rc.reconciled;
    stats.issues += rc.issues;

    stats.imported++;
    if (!stats.minDate || b.date < stats.minDate) stats.minDate = b.date;
    if (!stats.maxDate || b.date > stats.maxDate) stats.maxDate = b.date;
  }

  /* ---- 3. finish ---- */
  for (const e of errors) run('INSERT INTO import_errors(import_id, row_no, bill_no, level, message) VALUES (?,?,?,?,?)', importId, e.rowNo, e.billNo, e.level, e.message);
  const rowErrors = errors.filter((e) => e.level === 'ERROR').length;
  const status = stats.imported === 0 && (rowErrors || stats.error) ? 'FAILED' : rowErrors || stats.error ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
  run(
    `UPDATE imports SET status = ?, bills_total = ?, bills_imported = ?, bills_duplicate = ?, bills_error = ?, items_imported = ?, new_customers = ?,
       points_credited_cp = ?, points_reversed_cp = ?, redemptions_reconciled = ?, recon_issues = ?, min_bill_date = ?, max_bill_date = ? WHERE id = ?`,
    status, bills.size, stats.imported, stats.duplicate, stats.error, stats.items, stats.newCustomers,
    stats.creditedCp, stats.reversedCp, stats.reconciled, stats.issues, stats.minDate, stats.maxDate, importId,
  );
  if (stats.imported) {
    recomputeSegments();
    Object.assign(stats, afterPurchases(billDates));
    rebuildActivity();
  }
  audit({ type: staff.role, id: staff.id, name: staff.name }, 'EXCEL_IMPORT', 'import', importId, { filename, mode, status, ...stats }, ip);
  return { importId, status, mode, rowErrors, ...stats, errors: errors.slice(0, 200) };
}

export function templateWorkbook(mode = 'AMOUNT') {
  const ws = XLSX.utils.aoa_to_sheet(mode === 'POINTS' ? [
    POINTS_HEADERS,
    ['B1001', '23-09-2026', '18:40', 'ANN', '9840012345', '', 'Priya', 2200, 11, 'VR-260923-1048', 100, 'SALE', ''],
    ['B1002', '23-09-2026', '18:55', 'ANN', '9840055555', '', '', 640, 3.2, '', '', 'SALE', ''],
    ['R2001', '24-09-2026', '11:10', 'ANN', '9840012345', '', '', 450, 2.25, '', '', 'RETURN', 'B1001'],
  ] : [
    TEMPLATE_HEADERS,
    ['B1001', '23-09-2026', '18:40', 'ANN', '9840012345', '', 'Priya', 2500, 300, 2200, 'VR-260923-1048', 100, 'SALE', '', 'P100', 'Basmati Rice 5kg', 'Grocery', 1, 950, 50, 900],
    ['B1001', '23-09-2026', '18:40', 'ANN', '9840012345', '', 'Priya', 2500, 300, 2200, 'VR-260923-1048', 100, 'SALE', '', 'P220', 'Sunflower Oil 1L', 'Grocery', 2, 180, 0, 360],
    ['B1002', '23-09-2026', '18:55', 'ANN', '', '', '', 640, 0, 640, '', '', 'SALE', '', '', '', '', '', '', '', ''],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Bills');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
