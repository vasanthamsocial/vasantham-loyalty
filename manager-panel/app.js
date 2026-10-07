import { makeApi, esc, $, $$, pts, inr, dt, timeOnly, dateOnly, toast, modal, busy, statusBadge, todayIST } from '/shared/lib.js';
import { firebaseOtp, otpMode, preloadFirebaseOtp } from '/shared/otp.js';

const api = makeApi('vl_manager_token');
const root = $('#root');
let meta = null;
let tab = 'scan';
let scanner = null;
api.onUnauthorized = () => renderLogin();

/* ---------------- login ---------------- */
function renderLogin() {
  stopCamera();
  root.innerHTML = `
    <div class="login">
      <h1 style="color:var(--brand)">Vasantham Rewards</h1>
      <p class="muted">Manager Panel</p>
      <div class="card stack">
        <div class="field"><label for="u">Username</label><input id="u" autocomplete="username" /></div>
        <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" /></div>
        <button class="btn-primary btn-block btn-lg" id="login">Log in</button>
      </div>
    </div>`;
  const b = $('#login');
  b.onclick = busy(b, async () => {
    const r = await api.post('/auth/staff/login', { username: $('#u').value, password: $('#p').value });
    if (r.staff.role !== 'MANAGER') throw new Error('This login is not a branch manager. Use the Admin Panel.');
    api.token = r.token;
    boot();
  });
  $('#p').addEventListener('keydown', (e) => e.key === 'Enter' && b.click());
  $('#u').focus();
}

const mcan = (p) => !!meta?.staff?.permissions?.includes(p);

/* ---------------- shell ---------------- */
function shell() {
  root.innerHTML = `
    <header class="bar"><div class="row">
      <div><b>Vasantham Rewards</b> · Manager Panel</div>
      <div class="row small"><span>${esc(meta.staff.name)} <span class="muted">(${esc(meta.staff.access_label || 'Manager')})</span> · <b>${esc(meta.business.name)}</b> · ${esc(meta.staff.branch_name)}</span><button class="btn-sm" id="logout">Log out</button></div>
    </div></header>
    <nav class="mtabs">
      ${[['scan', 'Scan / Search'], ['today', "Today's redemptions"], ['pending', 'Pending reconciliation'], ['report', 'Daily report']]
        .filter(([k]) => k !== 'report' || mcan('counter.report'))
        .map(([k, l]) => `<button data-t="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}
    </nav>
    <main id="main"></main>`;
  $$('nav.mtabs button').forEach((b) => (b.onclick = () => show(b.dataset.t)));
  $('#logout').onclick = () => { api.token = null; renderLogin(); };
}

async function show(t) {
  stopCamera();
  tab = t;
  shell();
  $('#main').innerHTML = '<div class="spinner"></div>';
  try {
    await VIEWS[t]();
  } catch (e) {
    if (e.status !== 401) $('#main').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}

/* ---------------- camera ---------------- */
async function loadScannerLib() {
  if (window.Html5Qrcode) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load the camera scanner. Use a USB scanner or type the mobile number.'));
    document.head.appendChild(s);
  });
}
async function startCamera(onCode) {
  if (!window.isSecureContext) throw new Error('Camera needs HTTPS (or localhost). Use a USB/Bluetooth scanner or mobile search instead.');
  await loadScannerLib();
  scanner = new window.Html5Qrcode('reader');
  let done = false;
  await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 }, (text) => {
    if (done) return;
    done = true;
    stopCamera();
    onCode(text);
  });
}
function stopCamera() {
  if (scanner) {
    const s = scanner;
    scanner = null;
    s.stop().then(() => s.clear()).catch(() => {});
  }
}

/* ---------------- views ---------------- */
const VIEWS = {
  async scan() {
    $('#main').innerHTML = `
      <div class="two">
        <div class="card stack">
          <h2>Scan customer or redemption QR</h2>
          <div id="reader"></div>
          <button class="btn-primary btn-block" id="cam">Start camera</button>
          <div class="field"><label for="code">Or scan with a USB scanner / paste code</label>
            <input id="code" placeholder="Scanner input appears here" autocomplete="off" /></div>
        </div>
        <div class="card stack">
          <h2>Search by mobile number</h2>
          <div class="row"><input id="q" class="grow" inputmode="numeric" placeholder="Mobile number or member ID" style="flex:1;min-width:0" />
            <button class="btn-primary" id="search">Search</button></div>
          <p class="small muted">${meta.otpRequired ? 'For redemptions found by mobile number, the customer confirms with an OTP sent to their phone.' : ''}</p>
          <div id="enrolBox"><hr style="border:0;border-top:1px solid var(--line)" />
          <h3>Enrol a new customer</h3>
          <p class="small muted">No app needed. Points from today's bills are credited to this mobile number after the daily upload.</p>
          <div class="inline-fields"><input id="emob" inputmode="numeric" placeholder="Mobile number" /><input id="ename" placeholder="Name (optional)" /></div>
          <button id="enrol">Enrol customer</button></div>
        </div>
      </div>
      <div id="result" style="margin-top:16px"></div>`;
    const code = $('#code');
    code.focus();
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && code.value.trim()) {
        handleScan(code.value.trim());
        code.value = '';
      }
    });
    const cam = $('#cam');
    cam.onclick = busy(cam, async () => {
      if (scanner) { stopCamera(); cam.textContent = 'Start camera'; return; }
      cam.textContent = 'Stop camera';
      await startCamera((t) => { cam.textContent = 'Start camera'; handleScan(t); }).catch((e) => { cam.textContent = 'Start camera'; throw e; });
    });
    const sb = $('#search');
    sb.onclick = busy(sb, async () => {
      const r = await api.get(`/manager/search?q=${encodeURIComponent($('#q').value.trim())}`);
      if (!r.found) {
        $('#result').innerHTML = `<div class="alert warn">No customer found${r.mobile ? ` for ${esc(r.mobile)}. You can enrol them on the right.` : '.'}</div>`;
        if (r.mobile) $('#emob').value = r.mobile;
        return;
      }
      renderCustomer(r.customer, r.ticket, r.otpRequired);
    });
    $('#q').addEventListener('keydown', (e) => e.key === 'Enter' && sb.click());
    if (!mcan('counter.enrol')) $('#enrolBox').remove();
    const en = $('#enrol');
    if (en) en.onclick = busy(en, async () => {
      const r = await api.post('/manager/enrol', { mobile: $('#emob').value, name: $('#ename').value });
      toast(r.created ? 'Customer enrolled' : 'Customer already exists');
      renderCustomer(r.customer, null, meta.otpRequired);
    });
  },

  async today() {
    const date = $('#date')?.value || todayIST();
    const rows = await api.get(`/manager/redemptions?date=${date}`);
    $('#main').innerHTML = `
      <div class="row between"><h2>Redemptions</h2><input type="date" id="date" value="${date}" style="width:auto" /></div>
      ${redemptionTable(rows)}`;
    $('#date').onchange = () => VIEWS.today();
    bindRows();
  },

  async pending() {
    const rows = await api.get('/manager/pending');
    $('#main').innerHTML = `
      <h2>Pending reconciliation</h2>
      <p class="small muted">${meta.business.billing_source === 'MANAGER'
        ? 'Approved redemptions whose bill has not been confirmed yet. Open each one and enter the final bill number and amount once the sale is complete.'
        : "Approved redemptions that haven't yet been matched to a bill in the daily Excel upload. Make sure the cashier enters the Redemption ID in the bill remarks / loyalty reference field."}</p>
      ${redemptionTable(rows, true)}`;
    bindRows();
  },

  async report() {
    const date = $('#rdate')?.value || todayIST();
    const r = await api.get(`/manager/report?date=${date}`);
    $('#main').innerHTML = `
      <div class="row between"><h2>Daily report · ${esc(meta.staff.branch_name)}</h2><input type="date" id="rdate" value="${date}" style="width:auto" /></div>
      <div class="printable"><div class="small muted">${esc(meta.staff.branch_name)} · ${dateOnly(date)}</div><div class="grid k4">
        <div class="kpi"><div class="label">Redemptions</div><div class="value">${r.redemptions || 0}</div></div>
        <div class="kpi"><div class="label">Points redeemed</div><div class="value">${pts(r.points_cp)}</div></div>
        <div class="kpi"><div class="label">₹ value redeemed</div><div class="value">${inr(r.value_paise)}</div></div>
        <div class="kpi"><div class="label">Offers redeemed</div><div class="value">${r.offers || 0}</div><div class="sub">${inr(r.offers_value_paise)}</div></div>
        <div class="kpi"><div class="label">Cancelled / reversed</div><div class="value">${r.cancelled}</div></div>
        <div class="kpi"><div class="label">Pending reconciliation</div><div class="value">${r.pending_reconciliation}</div><div class="sub">${inr(r.pending_value_paise)} (all dates)</div></div>
      </div></div>
      <button style="margin-top:14px" onclick="window.print()">Print report</button>`;
    $('#rdate').onchange = () => VIEWS.report();
  },
};

function redemptionTable(rows, showDate) {
  if (!rows.length) return '<div class="empty card">Nothing here.</div>';
  return `<div class="table-wrap"><table>
    <tr><th>ID</th><th>${showDate ? 'Approved' : 'Time'}</th><th>Customer</th><th>Type</th><th class="num">Points</th><th class="num">Value</th><th>Status</th></tr>
    ${rows.map((r) => `<tr class="click" data-id="${esc(r.id)}">
      <td><b>${esc(r.id)}</b></td><td>${showDate ? dt(r.approved_at) : timeOnly(r.approved_at)}</td>
      <td>${esc(r.customer_name || '')}<div class="tiny muted">${esc(r.mobile)}</div></td>
      <td>${r.kind === 'POINTS' ? 'Points' : esc(r.offer_title || 'Offer')}</td>
      <td class="num">${r.kind === 'POINTS' ? pts(r.cp) : '–'}</td><td class="num">${inr(r.value_paise)}</td>
      <td>${statusBadge(r.status)}${r.cancel_reason ? `<div class="tiny muted">${esc(r.cancel_reason)}</div>` : ''}</td></tr>`).join('')}
  </table></div>`;
}
function bindRows() {
  $$('tr[data-id]').forEach((tr) => (tr.onclick = () => openReceipt(tr.dataset.id)));
}

/* ---------------- scan handling ---------------- */
async function handleScan(code) {
  try {
    const r = await api.post('/manager/scan', { code });
    if (r.type === 'REDEMPTION') renderRequest(r);
    else renderCustomer(r.customer, r.ticket, false);
  } catch (e) {
    toast(e.message, true);
  }
}

function customerPanel(c) {
  return `
    <div class="cust-head">
      <div><h2 style="margin:0">${esc(c.name || 'Customer')}</h2><div class="muted">${esc(c.mobile)} · ${esc(c.code)}</div>
        ${c.status !== 'ACTIVE' ? '<span class="badge red">BLOCKED</span>' : ''}</div>
      <div class="right"><div class="small muted">Available points</div><div class="bal">${esc(c.balance)}</div><div class="badge green">${inr(c.reward_value_paise)}</div></div>
    </div>`;
}

/** Most ₹ of points this outlet may accept for this customer on a bill (mirrors the server rule check). */
function allowedPaise(elig, billPaise) {
  const r = elig.business.rule;
  let cap = elig.max_paise_now;
  if (r.limit_type.includes('PERCENT') && billPaise > 0) cap = Math.min(cap, Math.floor((billPaise * r.max_percent) / 100));
  return Math.max(0, Math.floor(cap / 2) * 2); // whole centipoints (1 point = ₹2)
}
const billPaiseOf = (v) => { const n = Number(String(v || '').replace(/[,₹\s]/g, '')); return n > 0 ? Math.round(n * 100) : null; };

function eligibilityBox(c) {
  const e = c.eligibility;
  const r = e.business.rule;
  return `<div class="elig">
    <div class="row between"><b>${esc(e.business.name)} rules</b>${e.can_redeem_points ? '<span class="badge green">Can redeem points</span>' : '<span class="badge red">Cannot redeem points</span>'}</div>
    <ul class="small" style="margin:6px 0 0;padding-left:18px">${r.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    ${e.reasons.length ? `<div class="small neg" style="margin-top:4px">${e.reasons.map(esc).join('<br/>')}</div>` : ''}
    <div class="small" style="margin-top:4px">Up to <b>${inr(e.max_paise_now)}</b> (${pts(e.max_paise_now / 2)} points) available here${r.limit_type.includes('PERCENT') ? `, and no more than ${r.max_percent}% of the bill` : ''}.</div>
  </div>`;
}

function recentTable(c) {
  if (!c.recent.length) return '<p class="small muted">No previous redemptions.</p>';
  return `<table><tr><th>Date</th><th>Branch</th><th>Redemption</th><th>Status</th></tr>
    ${c.recent.map((r) => `<tr><td>${dt(r.approved_at || r.created_at)}</td><td>${esc(r.branch || '')}</td>
      <td>${r.kind === 'POINTS' ? `${pts(r.cp)} pts` : esc(r.offer_title)} · ${inr(r.value_paise)}</td><td>${statusBadge(r.status)}</td></tr>`).join('')}</table>`;
}

function offersList(c, withButtons) {
  const all = [...c.offers.forYou.map((o) => ({ ...o, mine: true })), ...c.offers.everyone];
  if (!all.length) return '<p class="small muted">No eligible offers.</p>';
  return all.map((o) => `
    <div class="offer-row ${o.mine ? 'personal' : ''}">
      <div><b>${esc(o.title)}</b> ${o.mine ? '<span class="badge gold">Personal</span>' : ''}
        <div class="tiny muted">${esc(o.conditions)} · till ${dateOnly(o.valid_to)}${o.coupon_code ? ` · ${esc(o.coupon_code)}` : ''}</div></div>
      ${o.redeemable ? `<div class="row">${o.points_cost_cp ? `<span class="badge gold">${esc(o.points_cost)} pts</span>` : '<span class="badge blue">Free unlock</span>'}<b>${inr(o.value_paise)}</b>${withButtons ? `<button class="btn-sm btn-primary" data-offer="${o.id}" ${o.points_cost_cp > c.balance_cp ? 'disabled title="Not enough points"' : ''}>Redeem</button>` : ''}</div>` : '<span class="badge">Auto on bill</span>'}
    </div>`).join('');
}

/** Pending request created by the customer in the app. */
function renderRequest(r) {
  const c = r.customer;
  const red = r.redemption;
  const rule = c.eligibility.business.rule;
  const minBill = Math.max(rule.min_bill_paise || 0, red.offer?.min_spend_paise || 0);
  const needBill = rule.needs_bill || minBill > 0;
  $('#result').innerHTML = `
    <div class="two">
      <div class="req stack">
        <div class="row between"><h2 style="margin:0">Redemption request</h2><span class="badge blue">${esc(red.id)}</span></div>
        <div class="amount">${red.kind === 'POINTS' ? `${pts(red.cp)} points = ${inr(red.value_paise)}` : `${esc(red.offer?.title)} · ${inr(red.value_paise)}${red.cp ? ` · ${pts(red.cp)} points` : ''}`}</div>
        ${minBill ? `<div class="alert warn">Customer's bill must be at least ${inr(minBill)}.</div>` : ''}
        ${needBill ? `<div class="field"><label for="bill">Customer's bill amount (₹, before this discount)</label><input id="bill" inputmode="decimal" placeholder="e.g. 500" /></div>` : ''}
        <div id="capNote" class="small"></div>
        <div class="small">Available: <b>${esc(c.balance)}</b> points${red.cp ? ` → after approval <b id="after">${pts(c.balance_cp - red.cp)}</b>` : ''}</div>
        <div class="row"><button class="btn-primary btn-lg grow" id="approve">Approve</button><button class="btn-lg" id="reject">Reject</button></div>
      </div>
      <div class="card stack">${customerPanel(c)}${eligibilityBox(c)}<h3>Recent redemptions</h3>${recentTable(c)}</div>
    </div>`;
  // For points, the approvable amount can be lower than requested (e.g. 20% of the bill).
  let approveCp = red.cp;
  const upd = () => {
    if (red.kind !== 'POINTS') return;
    const bill = billPaiseOf($('#bill')?.value);
    if (needBill && !bill) { $('#capNote').textContent = 'Enter the bill amount to check the limit.'; approveCp = red.cp; $('#approve').textContent = 'Approve'; return; }
    const allowCp = Math.floor(allowedPaise(c.eligibility, bill) / 2);
    approveCp = Math.min(red.cp, allowCp);
    $('#capNote').innerHTML = approveCp < red.cp
      ? `<span class="badge warn">Limit</span> ${esc(c.eligibility.business.name)} allows up to <b>${inr(approveCp * 2)}</b> here. Approving <b>${pts(approveCp)}</b> of ${pts(red.cp)} points; the rest stay in the customer's balance.`
      : '';
    $('#approve').textContent = approveCp > 0 ? `Approve ${pts(approveCp)} points (${inr(approveCp * 2)})` : 'Nothing can be redeemed on this bill';
    $('#approve').disabled = approveCp <= 0;
    if ($('#after')) $('#after').textContent = pts(c.balance_cp - approveCp);
  };
  $('#bill')?.addEventListener('input', upd);
  upd();
  const a = $('#approve');
  a.onclick = busy(a, async () => {
    const body = { ticket: r.ticket, bill_amount: $('#bill') ? $('#bill').value : undefined };
    if (red.kind === 'POINTS' && approveCp !== red.cp) body.points = (approveCp / 100).toFixed(2);
    const rc = await api.post(`/manager/redemptions/${encodeURIComponent(red.id)}/approve`, body);
    toast(rc.points ? 'Approved — points deducted' : 'Approved');
    openReceipt(rc.id);
  });
  $('#reject').onclick = () => cancelDialog(red.id, 'Reject request', () => { $('#result').innerHTML = '<div class="alert ok">Request rejected.</div>'; });
}

/** Customer identified by QR (ticket) or by search (OTP may be required). */
function renderCustomer(c, ticket, otpRequired) {
  const verified = !!ticket;
  $('#result').innerHTML = `
    <div class="two">
      <div class="card stack">
        ${customerPanel(c)}
        <div class="small">${verified ? '<span class="badge green">Verified in person</span>' : otpRequired ? '<span class="badge warn">Not verified</span> Verify with OTP to redeem.' : ''}</div>
        <div id="verifyBox"></div>
        ${eligibilityBox(c)}
        <div id="redeemBox" class="${verified ? '' : 'hidden'} stack">
          <div class="field"><label for="bill">Customer's bill amount (₹)${c.eligibility.business.rule.needs_bill ? '' : ' <span class="muted">(needed for offers with a minimum bill)</span>'}</label>
            <input id="bill" inputmode="decimal" placeholder="e.g. 500" /></div>
          <h3>Redeem points</h3>
          <div class="row"><input id="rp" inputmode="decimal" placeholder="Points" style="flex:1;min-width:0" /><span id="rpv" class="badge green">₹0</span>
            <button class="btn-primary" id="rpgo" ${c.eligibility.can_redeem_points ? '' : 'disabled'}>Approve</button></div>
          <div id="rpmax" class="small muted"></div>
        </div>
        <h3>Rewards &amp; coupons at ${esc(c.eligibility.business.name)}</h3>
        <div id="offers">${offersList(c, verified)}</div>
      </div>
      <div class="card stack"><h3>Recent redemption history</h3>${recentTable(c)}</div>
    </div>`;
  if (!verified && otpRequired) {
    $('#verifyBox').innerHTML = `<div class="row"><button id="sendOtp">Send OTP to customer</button>
      <input id="otp" inputmode="numeric" maxlength="6" placeholder="OTP" style="width:120px" class="hidden" />
      <button id="verifyOtp" class="btn-primary hidden">Verify</button></div><div id="otpHint" class="small muted"></div>`;
    let fb = null; // Firebase OTP session when the server uses Firebase
    const fbReady = preloadFirebaseOtp(api); // load Firebase before "Send OTP" is tapped
    const s = $('#sendOtp');
    s.onclick = busy(s, async () => {
      let r;
      if ((await otpMode(api)) === 'firebase') {
        fb = (await fbReady) || (await firebaseOtp(api));
        r = await fb.send(c.mobile);
      } else {
        r = await api.post(`/manager/customers/${c.id}/otp`);
      }
      $('#otp').classList.remove('hidden');
      $('#verifyOtp').classList.remove('hidden');
      $('#otpHint').textContent = r.devOtp ? `Demo mode (no SMS gateway): OTP is ${r.devOtp}` : 'Ask the customer for the OTP sent to their phone.';
      $('#otp').focus();
    });
    const v = $('#verifyOtp');
    v.onclick = busy(v, async () => {
      const r = fb
        ? await api.post(`/manager/customers/${c.id}/verify-firebase`, { idToken: await fb.verify($('#otp').value) })
        : await api.post(`/manager/customers/${c.id}/verify`, { otp: $('#otp').value });
      toast('Customer verified');
      renderCustomer(c, r.ticket, otpRequired);
    });
  }
  if (!verified) return;
  const rp = $('#rp');
  const showMax = () => {
    const bill = billPaiseOf($('#bill').value);
    const needs = c.eligibility.business.rule.needs_bill;
    const max = allowedPaise(c.eligibility, bill);
    $('#rpmax').innerHTML = needs && !bill ? 'Enter the bill amount to see the maximum.' : `Maximum here: <b>${pts(max / 2)}</b> points (${inr(max)})`;
  };
  rp.oninput = () => { const v = Number(rp.value); $('#rpv').textContent = v > 0 ? `₹${((Math.floor(v * 100) * 2) / 100).toLocaleString('en-IN')}` : '₹0'; };
  $('#bill').addEventListener('input', showMax);
  showMax();
  const go = $('#rpgo');
  go.onclick = busy(go, async () => {
    const v = rp.value.trim();
    if (!v) throw new Error('Enter points to redeem');
    if (!confirm(`Approve redemption of ${v} points for ${c.mobile} at ${c.eligibility.business.name}?`)) return;
    const rc = await api.post('/manager/redemptions/direct', { ticket, kind: 'POINTS', points: v, bill_amount: $('#bill').value });
    toast('Approved — points deducted');
    openReceipt(rc.id);
  });
  $$('[data-offer]').forEach((b) => (b.onclick = busy(b, async () => {
    const all = [...c.offers.forYou, ...c.offers.everyone];
    const o = all.find((x) => x.id === Number(b.dataset.offer));
    if (!confirm(`Approve "${o?.title}"${o?.points_cost_cp ? ` for ${o.points_cost} points` : ''}?`)) return;
    const rc = await api.post('/manager/redemptions/direct', { ticket, kind: 'OFFER', offerId: Number(b.dataset.offer), bill_amount: $('#bill').value });
    toast('Reward approved');
    openReceipt(rc.id);
  })));
}

/* ---------------- receipt ---------------- */
async function openReceipt(id) {
  const r = await api.get(`/manager/redemptions/${encodeURIComponent(id)}`);
  const canSubmit = r.status === 'APPROVED';
  const canCancel = ['APPROVED', 'SUBMITTED'].includes(r.status);
  const canConfirmBill = r.billing_source === 'MANAGER' && ['APPROVED', 'SUBMITTED'].includes(r.status);
  const m = modal(`
    <div class="row between"><h2>Redemption slip</h2><button data-close class="btn-sm">Close</button></div>
    <div class="printable">
      <div class="slip">
        <h3>VASANTHAM REWARDS</h3>
        <div style="text-align:center"><b>${esc(r.business)}</b><br/>Redemption slip — give to cashier · one-time use</div>
        <hr />
        <div class="line"><span>Redemption ID</span><b>${esc(r.id)}</b></div>
        <div class="line"><span>Customer</span><span>${esc(r.customer_name || '')} ${esc(r.customer_mobile_masked)}</span></div>
        <div class="line"><span>Business</span><span>${esc(r.business)}</span></div>
        <div class="line"><span>Branch</span><span>${esc(r.branch)}</span></div>
        <div class="line"><span>Type</span><span>${esc(r.type_label)}</span></div>
        <hr />
        ${r.offer ? `<div><b>${esc(r.offer)}</b>${r.coupon_code ? ` · ${esc(r.coupon_code)}` : ''}</div>${r.offer_conditions ? `<div>${esc(r.offer_conditions)}</div>` : ''}` : ''}
        ${r.points ? `<div class="line"><span>Points redeemed</span><b>${esc(r.points)}</b></div>` : ''}
        <div class="big">DISCOUNT: ${esc(r.value)}</div>
        ${r.min_bill ? `<div class="line"><span>Minimum bill</span><span>${esc(r.min_bill)}</span></div>` : ''}
        ${r.bill ? `<div class="line"><span>Bill amount</span><span>${esc(r.bill)}</span></div>` : ''}
        <hr />
        <div class="line"><span>Manager</span><span>${esc(r.approved_by)}</span></div>
        <div class="line"><span>Time</span><span>${esc(r.approved_at)}</span></div>
        <div class="line"><span>Status</span><span>${esc(r.status)}</span></div>
        <div class="qr">${r.qr}</div>
        <div style="text-align:center;font-size:11px">Cashier: apply ${esc(r.value)} loyalty discount and enter<br/><b>${esc(r.id)}</b> in bill remarks / loyalty ref.${r.partner_bill_no ? `<br/>Bill ${esc(r.partner_bill_no)}` : ''}</div>
        ${['REVERSED', 'CANCELLED'].includes(r.status) ? `<div class="big" style="margin-top:6px">*** ${esc(r.status)} ***</div>` : ''}
      </div>
    </div>
    <div class="row" style="margin-top:10px">Status: ${statusBadge(r.status)} ${r.cancel_reason ? `<span class="small muted">${esc(r.cancel_reason)}</span>` : ''}</div>
    <div class="row" style="margin-top:12px">
      ${canSubmit ? '<button class="btn-primary" id="print">Print &amp; hand over</button><button id="submit">Mark handed to billing</button>' : '<button id="reprint">Reprint</button>'}
      ${canConfirmBill ? '<button class="btn-primary" id="confirmBill">Confirm bill</button>' : ''}
      ${canCancel ? '<button class="btn-danger" id="cancel">Cancel / reverse</button>' : ''}
    </div>
    <details style="margin-top:12px"><summary class="small">History</summary>
      <table>${r.events.map((e) => `<tr><td class="small">${dt(e.created_at)}</td><td class="small">${esc(e.from_status || '')} → <b>${esc(e.to_status)}</b></td><td class="small">${esc(e.actor_type)}${e.note ? ` · ${esc(e.note)}` : ''}</td></tr>`).join('')}</table>
    </details>`, { wide: false });
  const submit = async () => { await api.post(`/manager/redemptions/${encodeURIComponent(r.id)}/submit`); };
  $('#print', m.el)?.addEventListener('click', busy($('#print', m.el), async () => { window.print(); await submit(); m.close(); openReceipt(r.id); }));
  $('#submit', m.el)?.addEventListener('click', busy($('#submit', m.el), async () => { await submit(); toast('Marked as submitted to billing'); m.close(); openReceipt(r.id); }));
  $('#reprint', m.el)?.addEventListener('click', () => window.print());
  $('#confirmBill', m.el)?.addEventListener('click', () => {
    m.close();
    const b = modal(`<h2>Confirm bill for ${esc(r.id)}</h2>
      <p class="small muted">Enter the bill once the sale is complete. This completes the redemption and records it for settlement.</p>
      <div class="field"><label>Bill number</label><input id="cbn" /></div>
      <div class="field"><label>Final bill amount (₹)</label><input id="cba" inputmode="decimal" value="${r.bill ? esc(r.bill.replace(/[₹,]/g, '')) : ''}" /></div>
      <div class="row"><button class="btn-primary" id="cbgo">Confirm</button><button data-close>Back</button></div>`);
    const g = $('#cbgo', b.el);
    g.onclick = busy(g, async () => {
      await api.post(`/manager/redemptions/${encodeURIComponent(r.id)}/bill`, { bill_no: $('#cbn', b.el).value, bill_amount: $('#cba', b.el).value });
      toast('Bill confirmed');
      b.close();
      openReceipt(r.id);
    });
  });
  $('#cancel', m.el)?.addEventListener('click', () => { m.close(); cancelDialog(r.id, 'Cancel / reverse redemption', () => openReceipt(r.id)); });
}

function cancelDialog(id, title, after) {
  const m = modal(`
    <h2>${esc(title)}</h2>
    <p class="small muted">${esc(id)}. Approved points are returned to the customer's balance. This is logged.</p>
    <div class="field"><label for="reason">Reason (required)</label><select id="reason"><option value="">Select…</option>${meta.cancelReasons.map((x) => `<option>${esc(x)}</option>`).join('')}</select></div>
    <div class="field"><label for="note">Details</label><input id="note" placeholder="Required if reason is Other" /></div>
    <div class="row"><button class="btn-danger" id="ok">Confirm</button><button data-close>Back</button></div>`);
  const ok = $('#ok', m.el);
  ok.onclick = busy(ok, async () => {
    const r = await api.post(`/manager/redemptions/${encodeURIComponent(id)}/cancel`, { reason: $('#reason', m.el).value, note: $('#note', m.el).value });
    toast(`Redemption ${r.status.toLowerCase()}`);
    m.close();
    after?.();
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    meta = await api.get('/manager/meta');
    show('scan');
  } catch (e) {
    if (e.status === 401 || e.status === 403) { api.token = null; renderLogin(); if (e.status === 403) toast(e.message, true); }
    else root.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}
if (api.token) boot();
else renderLogin();
