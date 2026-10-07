import { makeApi, esc, $, $$, pts, inr, pct, num, dt, dateOnly, toast, modal, busy, statusBadge, todayIST, LEDGER_LABEL } from '/shared/lib.js';

const api = makeApi('vl_admin_token');
const root = $('#root');
let me = null;
let branches = [];
let offerTypes = {};
let segLabels = {};
let businesses = [];
let bizMeta = null;
let segOptions = [];
api.onUnauthorized = () => renderLogin();

const NAV = [
  ['Overview', [['dashboard', 'Dashboard'], ['growth', 'Ecosystem growth'], ['liability', 'Loyalty liability']]],
  ['Customers', [['customers', 'Customer database'], ['segments', 'Segmentation'], ['ledger', 'Points ledger']]],
  ['Data', [['upload', 'Excel upload'], ['imports', 'Upload history']]],
  ['Rewards', [['offers', 'Offers'], ['campaigns', 'Campaigns']]],
  ['Redemptions', [['redemptions', 'Redemption monitor'], ['reconciliation', 'Reconciliation']]],
  ['Ecosystem', [['businesses', 'Businesses / Partners'], ['settlements', 'Settlements']]],
  ['Engagement', [['challenges', 'Milestones & challenges'], ['reactivation', 'Reactivation'], ['referrals', 'Referrals'], ['interests', 'Interest segments']]],
  ['Analytics', [['cust-analytics', 'Customer analytics'], ['branch-analytics', 'Branch analytics']]],
  ['Admin', [['branches', 'Branches & staff'], ['settings', 'Settings'], ['audit', 'Audit logs']]],
];

/* ---------------- login ---------------- */
function renderLogin() {
  root.innerHTML = `
    <div class="login">
      <h1 style="color:var(--brand)">Vasantham Rewards</h1>
      <p class="muted">Admin Panel</p>
      <div class="card stack">
        <div class="field"><label for="u">Username</label><input id="u" autocomplete="username" /></div>
        <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" /></div>
        <button class="btn-primary btn-block btn-lg" id="login">Log in</button>
      </div>
    </div>`;
  const b = $('#login');
  b.onclick = busy(b, async () => {
    const r = await api.post('/auth/staff/login', { username: $('#u').value, password: $('#p').value });
    if (r.staff.role !== 'ADMIN') throw new Error('This login is not an admin. Use the Manager Panel.');
    api.token = r.token;
    boot();
  });
  $('#p').addEventListener('keydown', (e) => e.key === 'Enter' && b.click());
  $('#u').focus();
}

/* ---------------- shell & routing ---------------- */
function shell(active) {
  const sideScroll = $('#side')?.scrollTop || 0; // the layout is re-rendered on every navigation; keep the menu where it was
  root.innerHTML = `
    <div class="layout">
      <aside id="side">
        <div class="logo">Vasantham <span>Rewards</span><div class="tiny" style="color:#8fb9a2;font-weight:500">Admin Panel</div></div>
        ${NAV.map(([g, items]) => [g, items.filter(([k]) => canView(k)).map(([k, l]) => [k, k === 'branches' && !can('staff.manage') ? 'Branches' : l])]).filter(([, items]) => items.length)
          .map(([g, items]) => `<div class="group">${g}</div>${items.map(([k, l]) => `<button data-r="${k}" class="${active === k ? 'active' : ''}">${l}</button>`).join('')}`).join('')}
        <div class="me">${esc(me?.name || '')}<div class="tiny" style="color:#8fb9a2">${esc(me?.access_label || '')}${me?.business_name ? ` · ${esc(me.business_name)}` : ''}</div><button id="logout" style="padding:4px 0;color:#ffd66b">Log out</button></div>
      </aside>
      <main><button class="menu-toggle btn-sm" id="menu" style="margin-bottom:10px">☰ Menu</button><div id="main"></div></main>
    </div>`;
  $$('aside [data-r]').forEach((b) => (b.onclick = () => { location.hash = `#/${b.dataset.r}`; }));
  $('#logout').onclick = () => { api.token = null; me = null; renderLogin(); };
  $('#menu').onclick = () => $('#side').classList.toggle('open');
  const side = $('#side');
  side.scrollTop = sideScroll;
  $('button.active', side)?.scrollIntoView({ block: 'nearest' }); // e.g. opened from a link or bookmark
}

async function route() {
  const [path] = location.hash.slice(1).split('?');
  const [, rawName, arg] = path.split('/');
  const name = rawName || firstView();
  const view = VIEWS[name] && canView(name) ? name : firstView();
  shell(name === 'customer' ? 'customers' : view === 'campaign' ? 'campaigns' : view);
  const main = $('#main');
  main.innerHTML = '<div class="spinner"></div>';
  try {
    await VIEWS[view](main, arg && decodeURIComponent(arg));
  } catch (e) {
    if (e.status !== 401) main.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);

const head = (title, actions = '') => `<div class="page-head"><h1>${title}</h1><div class="row">${actions}</div></div>`;
const kpi = (label, value, sub = '') => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
const branchOptions = (sel, all = 'All branches') => `<option value="">${all}</option>${branches.map((b) => `<option value="${b.id}" ${String(sel) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}`;
const segName = (s) => segLabels[s] || (s?.startsWith('CAT:') ? `Category: ${s.slice(4)}` : s === 'ALL' ? 'All customers' : s);
function pager(el, data, reload) {
  const pages = Math.max(1, Math.ceil(data.total / data.size));
  el.insertAdjacentHTML('beforeend', `<div class="pager small"><span class="muted">${num(data.total)} records · page ${data.page} of ${pages}</span>
    <button class="btn-sm" data-pg="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>‹ Prev</button><button class="btn-sm" data-pg="${data.page + 1}" ${data.page >= pages ? 'disabled' : ''}>Next ›</button></div>`);
  $$('[data-pg]', el).forEach((b) => (b.onclick = () => reload(Number(b.dataset.pg))));
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();


/* ---------------- ecosystem helpers ---------------- */
const bizOptions = (sel, all = 'All businesses') => `${all ? `<option value="">${all}</option>` : ''}${businesses.map((b) => `<option value="${b.id}" ${String(sel) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}`;
const bizName = (id) => businesses.find((b) => b.id === Number(id))?.name || '';
const ownerBiz = () => businesses.find((b) => b.is_program_owner);
const yn = (v, yes, no) => `<span class="badge ${v ? 'green' : ''}">${v ? yes : no}</span>`;
const logoBox = (b, size = 44) => b.logo_url
  ? `<img src="${esc(b.logo_url)}" alt="" class="biz-logo" style="width:${size}px;height:${size}px" />`
  : `<div class="biz-logo biz-initials" style="width:${size}px;height:${size}px">${esc(b.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase())}</div>`;

function bizCard(b) {
  return `<div class="card biz-card">
    <div class="row" style="flex-wrap:nowrap;align-items:flex-start">${logoBox(b)}
      <div class="grow"><div class="row between"><h3 style="margin:0">${esc(b.name)}</h3><button class="btn-sm" data-biz="${b.id}">Edit</button></div>
        <div class="tiny muted">${esc(b.code)}${b.category ? ` · ${esc(b.category)}` : ''}${b.is_program_owner ? ' · <b>program owner</b>' : ''}</div></div></div>
    <div class="row" style="gap:6px;margin-top:8px">${b.active ? '' : '<span class="badge red">Inactive</span>'}${yn(b.can_earn, 'Earns points', 'No earning')}${yn(b.can_redeem, 'Redeem: yes', 'Redeem: no')}
      ${b.offer_participation ? '' : '<span class="badge">No offers</span>'}<span class="badge blue">${b.billing_source === 'EXCEL' ? 'Excel billing' : 'Outlet confirms bills'}</span></div>
    <ul class="small" style="margin:8px 0 0;padding-left:18px">${b.rule.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="small muted" style="margin-top:6px">Outlets: ${b.outlets.map((o) => esc(o.name)).join(', ') || '<span class="neg">none yet: add under Branches &amp; staff</span>'}</div>
    <div class="small muted">${num(b.stats.redemptions)} redemptions · ${inr(b.stats.value_paise)} · ${num(b.stats.customers)} customers · ${num(b.live_offers)} live offers · settles ${esc(b.settlement_cycle.toLowerCase())}</div>
  </div>`;
}

function businessForm(b, done) {
  const isNew = !b;
  b = b || { active: 1, can_earn: 0, can_redeem: 1, offer_participation: 1, billing_source: 'MANAGER', settlement_cycle: 'MONTHLY', rule: { limit_type: 'NONE', min_bill_paise: 0, min_points_cp: 0 }, outlets: [] };
  const r = b.rule;
  const chk = (id, v, label, dis = false) => `<label class="chk"><input type="checkbox" id="${id}" ${v ? 'checked' : ''} ${dis ? 'disabled' : ''} /> ${label}</label>`;
  const selOutlets = (r.branch_ids || '').split(',').filter(Boolean);
  const profileOnly = !can('businesses.manage');
  const m = modal(`<div class="row between"><h2>${isNew ? 'Add business' : `Edit ${esc(b.name)}`}</h2><button data-close class="btn-sm">Close</button></div>
    ${profileOnly ? '<div class="alert info small">You can update your marketplace line, contact details and terms. Permissions, redemption rules and settlement terms are managed by the Vasantham loyalty team.</div>' : ''}
    <h3>Profile</h3>
    <div class="inline-fields">
      <div class="field"><label>Business name</label><input id="bz-name" value="${esc(b.name || '')}" /></div>
      <div class="field"><label>Business code</label><input id="bz-code" value="${esc(b.code || '')}" ${isNew ? '' : 'disabled'} placeholder="e.g. HOF" /></div>
      <div class="field"><label>Category</label><input id="bz-cat" value="${esc(b.category || '')}" placeholder="e.g. Food, Pharmacy" /></div>
      <div class="field"><label>Display order</label><input id="bz-sort" inputmode="numeric" value="${esc(b.sort_order ?? 100)}" /></div>
    </div>
    <div class="field"><label>Marketplace line (shown to customers)</label><input id="bz-tag" value="${esc(b.tagline || '')}" placeholder="e.g. Redeem points on food purchases" /></div>
    <div class="field"><label>Logo</label>
      ${b.logo_url ? `<div class="row small" style="margin-bottom:6px">${logoBox(b, 36)}<label class="chk"><input type="checkbox" id="bz-logo-rm" /> Remove</label></div>` : ''}
      <input type="file" id="bz-logo" accept="image/jpeg,image/png,image/webp" /><div class="tiny muted">Square JPG, PNG or WebP, up to 2 MB.</div></div>
    <h3>Permissions</h3>
    <div class="row">${chk('bz-active', b.active, 'Active', b.is_program_owner)}${chk('bz-earn', b.can_earn, 'Can earn points')}${chk('bz-redeem', b.can_redeem, 'Can redeem points')}${chk('bz-offers', b.offer_participation, 'Takes part in offers / coupons')}</div>
    <div class="field" style="margin-top:8px"><label>How bills are confirmed</label><select id="bz-bill">${Object.entries(bizMeta.billingSources).map(([k, l]) => `<option value="${k}" ${b.billing_source === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <h3>Redemption rules</h3>
    <div class="inline-fields">
      <div class="field"><label>Limit type</label><select id="rl-type">${Object.entries(bizMeta.limitTypes).map(([k, l]) => `<option value="${k}" ${r.limit_type === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="field" data-rl="pct"><label>Maximum % of bill</label><input id="rl-pct" inputmode="decimal" value="${esc(r.max_percent ?? '')}" placeholder="e.g. 20" /></div>
      <div class="field" data-rl="amt"><label>Maximum ₹ per redemption</label><input id="rl-amt" inputmode="decimal" value="${r.max_value_paise ? r.max_value_paise / 100 : ''}" /></div>
      <div class="field"><label>Minimum bill (₹)</label><input id="rl-bill" inputmode="decimal" value="${r.min_bill_paise ? r.min_bill_paise / 100 : ''}" placeholder="0" /></div>
      <div class="field"><label>Minimum points</label><input id="rl-pts" inputmode="decimal" value="${r.min_points_cp ? r.min_points_cp / 100 : ''}" placeholder="0" /></div>
    </div>
    ${isNew ? '<p class="tiny muted">Add outlets under Branches &amp; staff after saving; you can then limit redemptions to some outlets.</p>'
      : `<div class="field"><label>Eligible outlets (none selected = all outlets)</label><div class="row">${b.outlets.map((o) => `<label class="chk"><input type="checkbox" data-outlet="${o.id}" ${selOutlets.includes(String(o.id)) ? 'checked' : ''} /> ${esc(o.name)}</label>`).join('') || '<span class="small muted">No outlets yet</span>'}</div></div>`}
    <h3>Settlement</h3>
    <div class="inline-fields">
      <div class="field"><label>Settlement cycle</label><select id="bz-cycle">${bizMeta.settlementCycles.map((c) => `<option ${b.settlement_cycle === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field" style="grid-column:span 2"><label>Settlement account / details</label><input id="bz-settle" value="${esc(b.settlement_details || '')}" placeholder="Bank / UPI / ledger account" /></div>
    </div>
    <h3>Contact</h3>
    <div class="inline-fields">
      <div class="field"><label>Contact person</label><input id="bz-person" value="${esc(b.contact_person || '')}" /></div>
      <div class="field"><label>Phone</label><input id="bz-phone" inputmode="tel" value="${esc(b.contact_phone || '')}" /></div>
      <div class="field"><label>Email</label><input id="bz-email" type="email" value="${esc(b.contact_email || '')}" /></div>
    </div>
    <div class="field"><label>Address</label><input id="bz-addr" value="${esc(b.address || '')}" /></div>
    <div class="field"><label>Terms &amp; conditions (shown to customers)</label><textarea id="bz-terms" rows="3">${esc(b.terms || '')}</textarea></div>
    <div class="field"><label>Internal notes</label><textarea id="bz-notes" rows="2">${esc(b.notes || '')}</textarea></div>
    <div class="row"><button class="btn-primary" id="bz-save">${isNew ? 'Create business' : 'Save changes'}</button><button data-close>Cancel</button></div>`, { wide: true });
  const syncRule = () => {
    const t = $('#rl-type', m.el).value;
    $('[data-rl="pct"]', m.el).classList.toggle('hidden', !t.includes('PERCENT'));
    $('[data-rl="amt"]', m.el).classList.toggle('hidden', !(t === 'AMOUNT' || t === 'PERCENT_AND_AMOUNT'));
  };
  $('#rl-type', m.el).onchange = syncRule;
  syncRule();
  if (profileOnly) {
    const editable = new Set(['bz-tag', 'bz-person', 'bz-phone', 'bz-email', 'bz-addr', 'bz-terms', 'bz-logo', 'bz-logo-rm']);
    $$('input, select, textarea', m.el).forEach((i) => { if (i.id && !editable.has(i.id)) i.disabled = true; });
  }
  const s = $('#bz-save', m.el);
  s.onclick = busy(s, async () => {
    const v = (id) => $(`#${id}`, m.el).value;
    const body = {
      code: v('bz-code'), name: v('bz-name'), category: v('bz-cat'), sort_order: v('bz-sort'), tagline: v('bz-tag'),
      active: $('#bz-active', m.el).checked, can_earn: $('#bz-earn', m.el).checked, can_redeem: $('#bz-redeem', m.el).checked, offer_participation: $('#bz-offers', m.el).checked,
      billing_source: v('bz-bill'), settlement_cycle: v('bz-cycle'), settlement_details: v('bz-settle'),
      contact_person: v('bz-person'), contact_phone: v('bz-phone'), contact_email: v('bz-email'), address: v('bz-addr'), terms: v('bz-terms'), notes: v('bz-notes'),
      rule: { limit_type: v('rl-type'), max_percent: v('rl-pct'), max_value: v('rl-amt'), min_bill: v('rl-bill'), min_points: v('rl-pts'),
        branch_ids: $$('[data-outlet]', m.el).filter((c) => c.checked).map((c) => Number(c.dataset.outlet)) },
    };
    const saved = isNew ? await api.post('/admin/businesses', body) : await api.put(`/admin/businesses/${b.id}`, body);
    const logo = $('#bz-logo', m.el).files[0];
    if (logo) await api.call('POST', `/admin/businesses/${saved.id}/logo`, undefined, { raw: logo });
    else if ($('#bz-logo-rm', m.el)?.checked) await api.call('DELETE', `/admin/businesses/${saved.id}/logo`);
    businesses = await api.get('/admin/businesses');
    toast(isNew ? 'Business created' : 'Business saved');
    m.close();
    done();
  });
}

/** Weekly (Mon–Sun) / monthly presets in IST. */
function periodRange(preset, from, to) {
  const today = todayIST();
  const d = new Date(`${today}T00:00:00Z`);
  const iso = (x) => x.toISOString().slice(0, 10);
  const add = (x, n) => { const y = new Date(x); y.setUTCDate(y.getUTCDate() + n); return y; };
  const monday = add(d, -((d.getUTCDay() + 6) % 7));
  if (preset === 'this-week') return { from: iso(monday), to: today };
  if (preset === 'last-week') return { from: iso(add(monday, -7)), to: iso(add(monday, -1)) };
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (preset === 'this-month') return { from: iso(first), to: today };
  if (preset === 'last-month') return { from: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))), to: iso(add(first, -1)) };
  return { from: from || iso(first), to: to || today };
}

function settlementLines(rows) {
  return `<div class="table-wrap" style="max-height:60vh;overflow:auto"><table><tr><th>Date</th><th>Redemption</th><th>Outlet</th><th>Customer</th><th>Type</th><th>Line</th><th class="num">Amount</th><th>Status</th></tr>
    ${rows.map((t) => `<tr><td class="small">${dt(t.created_at)}</td><td><b>${esc(t.redemption_id)}</b></td><td class="small">${esc(t.branch || '')}</td><td class="small">${esc(t.mobile)}</td>
      <td class="small">${t.kind === 'POINTS' ? `${pts(t.cp)} pts` : esc(t.offer_title || t.kind)}</td><td class="small">${esc(t.direction === 'PAYABLE' ? 'Payable' : 'Receivable')}: ${esc(t.note || '')}</td>
      <td class="num ${t.amount_paise < 0 ? 'neg' : ''}">${inr(t.amount_paise)}</td><td>${statusBadge(t.redemption_status)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Nothing here</td></tr>'}</table></div>`;
}



/* ---------------- permissions ---------------- */
const can = (p) => !!me?.permissions && (me.permissions.includes('*') || me.permissions.includes(p));
const canAny = (list) => list.split('|').some(can);
/** Menu entry → permission needed to see it. */
const VIEW_PERM = {
  dashboard: 'dashboard.view', growth: 'growth.view', liability: 'analytics.view', customers: 'customers.view', customer: 'customers.view', segments: 'customers.view',
  ledger: 'customers.view', upload: 'data.upload', imports: 'data.upload', offers: 'offers.view', campaigns: 'campaigns.view', campaign: 'campaigns.view',
  redemptions: 'redemptions.view', reconciliation: 'redemptions.view', businesses: 'businesses.view', settlements: 'settlements.view',
  challenges: 'engagement.view', reactivation: 'engagement.view', referrals: 'engagement.view', interests: 'engagement.view',
  'cust-analytics': 'analytics.view', 'branch-analytics': 'analytics.view', branches: 'branches.view', settings: 'settings.manage', audit: 'audit.view',
};
// Vasantham-wide screens, hidden from single-business logins (the server refuses them too)
const UNSCOPED_VIEWS = new Set(['dashboard', 'liability', 'customers', 'customer', 'segments', 'ledger', 'upload', 'imports', 'campaigns', 'campaign', 'reconciliation',
  'challenges', 'reactivation', 'referrals', 'interests', 'cust-analytics', 'branch-analytics', 'audit']);
const canView = (v) => can(VIEW_PERM[v] || '*') && !(me?.business_id && UNSCOPED_VIEWS.has(v));
const firstView = () => ['dashboard', 'growth', 'offers', 'redemptions', 'settlements'].find(canView) || 'offers';
/** Actions removed from the page for roles that can't use them (the server refuses them anyway). */
const MANAGE_SELECTORS = [
  ['offers.manage', '#newo, [data-edit], [data-toggle]'],
  ['campaigns.manage', '#newc, [data-camp]:not(tr)'],
  ['businesses.manage', '#newb'],
  ['settlements.manage', '[data-settle], [data-paid], [data-void]'],
  ['engagement.manage', '#nsp, #nvi, [data-ce], [data-ct], #na, [data-ae], [data-ar], #np, [data-pe], [data-rj], #ni, [data-ie]'],
  ['branches.manage', '#badd, [data-eb], .add-branch'],
  ['redemptions.manage', '#rev, #rec'],
  ['reconciliation.manage', '[data-resolve]'],
  ['customers.edit', '#ago, #psave'],
];
function prune(scope) {
  for (const [perm, sel] of MANAGE_SELECTORS) if (!can(perm)) $$(sel, scope).forEach((e) => e.remove());
  if (me?.business_id) $$('[data-assign], [data-notify]', scope).forEach((e) => e.remove()); // partners don't message all customers
}
new MutationObserver(() => prune(document)).observe(document.body, { childList: true, subtree: true });

/* ---------------- growth chart ---------------- */
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
/** Single-series column chart of the ratio by month (one axis, value on each cap, hover for details). */
function ratioChart(rows) {
  const W = 640, H = 220, padL = 44, padB = 28, padT = 22, bw = 24;
  const vals = rows.map((r) => r.ratio ?? 0);
  const maxV = Math.max(1, ...vals);
  const step = maxV <= 5 ? 1 : maxV <= 20 ? 5 : maxV <= 50 ? 10 : Math.pow(10, Math.floor(Math.log10(maxV)));
  const top = Math.ceil(maxV / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const slot = (W - padL) / rows.length;
  const ticks = [];
  for (let t = 0; t <= top; t += step) ticks.push(t);
  const bar = (v, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    const y0 = y(0), y1 = y(v);
    const h = y0 - y1;
    if (h <= 0) return '';
    const r = Math.min(4, h);
    return `<path d="M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0} Z" class="col" />`;
  };
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Revenue associated with redemption divided by reward value, by month">
    ${ticks.map((t) => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid" /><text x="${padL - 8}" y="${y(t) + 4}" class="tick" text-anchor="end">${t}×</text>`).join('')}
    ${rows.map((r, i) => `<g class="hit" data-tip="${esc(`${monthName(r.month)}|${r.ratio == null ? 'No rewards used' : `${r.ratio.toFixed(1)}×`}|Revenue with a reward ${inr(r.linked_revenue_paise)}|Reward value used ${inr(r.reward_value_paise)}|${num(r.redemptions)} redemptions`)}">
        <rect x="${padL + slot * i}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent" />
        ${bar(r.ratio ?? 0, i)}
        ${r.ratio != null ? `<text x="${padL + slot * i + slot / 2}" y="${y(r.ratio) - 6}" class="cap" text-anchor="middle">${r.ratio.toFixed(1)}×</text>` : ''}
        <text x="${padL + slot * i + slot / 2}" y="${H - 8}" class="tick" text-anchor="middle">${esc(monthName(r.month).split(' ')[0])}</text></g>`).join('')}
  </svg><div class="chart-tip hidden"></div></div>`;
}
function bindChartTips(root) {
  $$('.chart-wrap', root).forEach((w) => {
    const tip = $('.chart-tip', w);
    $$('[data-tip]', w).forEach((g) => {
      g.addEventListener('mouseenter', () => {
        const [title, value, ...rest] = g.dataset.tip.split('|');
        tip.innerHTML = `<b>${esc(title)}</b><div class="tv">${esc(value)}</div>${rest.map((x) => `<div>${esc(x)}</div>`).join('')}`;
        tip.classList.remove('hidden');
        const box = w.getBoundingClientRect(), gb = g.getBoundingClientRect();
        tip.style.left = `${Math.min(box.width - 220, Math.max(0, gb.left - box.left + gb.width / 2 - 100))}px`;
        tip.style.top = '4px';
        g.classList.add('on');
      });
      g.addEventListener('mouseleave', () => { tip.classList.add('hidden'); g.classList.remove('on'); });
    });
  });
}

/* ---------------- engagement helpers ---------------- */
const segSelect = (id, sel, { all = 'All customers' } = {}) => `<select id="${id}">${all ? `<option value="">${all}</option>` : ''}${segOptions.map((s) => `<option value="${esc(s.code)}" ${sel === s.code ? 'selected' : ''}>${esc(s.label)} (${num(s.n)})</option>`).join('')}</select>`;
const offerLabel = (o) => `${o.title} — ${o.business_name || ''}${o.points_cost_cp ? ` · ${pts(o.points_cost_cp)} pts` : ''} · ${inr(o.value_paise)}`;

/** Reward picker: bonus points or a personalised offer. prefix scopes the element ids. */
function rewardFields(prefix, r = {}, personal) {
  const type = r.type || r.reward_type || 'POINTS';
  return `<div class="inline-fields" data-reward="${prefix}">
    <div class="field"><label>Reward</label><select id="${prefix}-type"><option value="POINTS" ${type === 'POINTS' ? 'selected' : ''}>Bonus points</option><option value="OFFER" ${type === 'OFFER' ? 'selected' : ''}>Offer / coupon (any business)</option></select></div>
    <div class="field" data-rt="POINTS"><label>Bonus points</label><input id="${prefix}-pts" inputmode="decimal" value="${(r.cp ?? r.reward_cp) ? (r.cp ?? r.reward_cp) / 100 : ''}" /></div>
    <div class="field" data-rt="OFFER"><label>Offer to unlock (personalised)</label><select id="${prefix}-offer">${personal.map((o) => `<option value="${o.id}" ${(r.offer_id ?? r.reward_offer_id) === o.id ? 'selected' : ''}>${esc(offerLabel(o))}</option>`).join('') || '<option value="">No personalised offers yet</option>'}</select></div>
  </div>`;
}
function wireReward(root, prefix) {
  const sync = () => {
    const t = $(`#${prefix}-type`, root).value;
    $$(`[data-reward="${prefix}"] [data-rt]`, root).forEach((f) => f.classList.toggle('hidden', f.dataset.rt !== t));
  };
  $(`#${prefix}-type`, root).onchange = sync;
  sync();
}
const readReward = (root, prefix) => ({ type: $(`#${prefix}-type`, root).value, points: $(`#${prefix}-pts`, root).value, offer_id: Number($(`#${prefix}-offer`, root).value) || null });

function challengeForm(c, meta, personal, done) {
  const isNew = !c.id;
  const earners = businesses.filter((b) => b.can_earn);
  const bizId = c.business_id || earners[0]?.id;
  const selBr = (c.branch_ids || '').split(',').filter(Boolean);
  const tierRow = (t, i) => `<div class="tier card flat" data-tier="${i}" style="padding:.6rem;margin-bottom:.5rem">
      <div class="row between"><b>Tier ${i + 1}</b><button class="btn-sm" data-rm="${i}">Remove</button></div>
      <div class="inline-fields"><div class="field"><label>${c.type === 'SPEND' ? 'Spend target (₹)' : 'Number of visits'}</label>
        <input data-th inputmode="decimal" value="${t.threshold ? (c.type === 'SPEND' ? t.threshold / 100 : t.threshold) : ''}" /></div>
        <div class="field"><label>Reward valid for (days)</label><input data-vd inputmode="numeric" value="${t.reward_valid_days || 30}" /></div></div>
      ${rewardFields(`t${i}`, t, personal)}</div>`;
  let tiers = (c.tiers && c.tiers.length ? c.tiers : [{}]).map((t) => ({ ...t }));
  const today = todayIST();
  const m = modal(`<div class="row between"><h2>${isNew ? (c.type === 'SPEND' ? 'New spend milestone' : 'New visit challenge') : `Edit ${esc(c.name)}`}</h2><button data-close class="btn-sm">Close</button></div>
    <div class="inline-fields">
      <div class="field"><label>Name</label><input id="cn" value="${esc(c.name || (c.type === 'SPEND' ? 'Monthly Spend Challenge' : 'Visit Vasantham 4 times this month'))}" /></div>
      <div class="field"><label>Type</label><select id="cty">${Object.entries(meta.types).map(([k, l]) => `<option value="${k}" ${c.type === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="field"><label>Measurement period</label><select id="cpe">${Object.entries(meta.periods).map(([k, l]) => `<option value="${k}" ${(c.period || 'MONTHLY') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Description (shown to customers)</label><input id="cd" value="${esc(c.description || '')}" /></div>
    <div class="inline-fields">
      <div class="field"><label>Purchases counted at</label><select id="cbz">${earners.map((b) => `<option value="${b.id}" ${b.id === bizId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Eligible customers</label>${segSelect('cseg', c.segment)}</div>
      <div class="field" id="cmbw"><label>Minimum bill per visit (₹)</label><input id="cmb" inputmode="decimal" value="${c.min_bill_paise ? c.min_bill_paise / 100 : ''}" placeholder="0" /></div>
    </div>
    <div class="inline-fields">
      <div class="field"><label>Valid from</label><input type="date" id="cf" value="${c.valid_from || today}" /></div>
      <div class="field"><label>Valid to</label><input type="date" id="ct" value="${c.valid_to || ''}" /></div>
    </div>
    <div class="field"><label>Participating branches (none selected = all)</label><div class="row">${branches.filter((b) => b.business_id === bizId).map((b) => `<label class="chk"><input type="checkbox" data-cbr="${b.id}" ${selBr.includes(String(b.id)) ? 'checked' : ''} /> ${esc(b.name)}</label>`).join('')}</div></div>
    <div class="row"><label class="chk"><input type="checkbox" id="crep" ${c.repeatable === 0 ? '' : 'checked'} /> Can be earned again every period</label>
      <label class="chk"><input type="checkbox" id="cac" ${c.active === 0 ? '' : 'checked'} /> Active</label></div>
    <h3 style="margin-top:12px">Reward tiers</h3>
    ${c.tiers?.some((t) => t.awarded_total) ? '<p class="small muted">Rewards have been given, so the type, period and tiers are locked. Deactivate this challenge and create a new one to change them.</p>' : ''}
    <div id="tiers"></div><button class="btn-sm" id="addt">+ Add tier</button>
    <div class="row" style="margin-top:14px"><button class="btn-primary" id="cs">${isNew ? 'Create' : 'Save'}</button><button data-close>Cancel</button></div>`, { wide: true });
  const renderTiers = () => {
    $('#tiers', m.el).innerHTML = tiers.map(tierRow).join('');
    tiers.forEach((_, i) => wireReward(m.el, `t${i}`));
    $$('[data-rm]', m.el).forEach((b) => (b.onclick = () => { collect(); tiers.splice(Number(b.dataset.rm), 1); renderTiers(); }));
  };
  const collect = () => {
    tiers = $$('[data-tier]', m.el).map((row, i) => {
      const r = readReward(m.el, `t${i}`);
      const th = Number($('[data-th]', row).value);
      return { threshold: c.type === 'SPEND' ? Math.round(th * 100) : th, reward_valid_days: Number($('[data-vd]', row).value), type: r.type, cp: Math.round(Number(r.points || 0) * 100), offer_id: r.offer_id,
        raw: { threshold: $('[data-th]', row).value, valid_days: $('[data-vd]', row).value, reward: r } };
    });
  };
  renderTiers();
  const syncType = () => { c.type = $('#cty', m.el).value; $('#cmbw', m.el).classList.toggle('hidden', c.type !== 'VISITS'); };
  $('#cty', m.el).onchange = () => { collect(); syncType(); renderTiers(); };
  syncType();
  $('#addt', m.el).onclick = () => { collect(); tiers.push({}); renderTiers(); };
  const s = $('#cs', m.el);
  s.onclick = busy(s, async () => {
    collect();
    const body = {
      name: $('#cn', m.el).value, type: $('#cty', m.el).value, period: $('#cpe', m.el).value, description: $('#cd', m.el).value, business_id: Number($('#cbz', m.el).value),
      segment: $('#cseg', m.el).value || null, min_bill: $('#cmb', m.el).value, valid_from: $('#cf', m.el).value, valid_to: $('#ct', m.el).value,
      branch_ids: $$('[data-cbr]', m.el).filter((x) => x.checked).map((x) => Number(x.dataset.cbr)),
      repeatable: $('#crep', m.el).checked, active: $('#cac', m.el).checked, tiers: tiers.map((t) => t.raw),
    };
    if (isNew) await api.post('/admin/challenges', body); else await api.put(`/admin/challenges/${c.id}`, body);
    toast('Challenge saved');
    m.close();
    done();
  });
}

function automationForm(a, personal, done) {
  a = a || { cooldown_days: 60, window_days: 30, reward_valid_days: 14, active: 0 };
  const m = modal(`<h2>${a.id ? `Edit ${esc(a.name)}` : 'New reactivation automation'}</h2>
    <div class="field"><label>Name</label><input id="an" value="${esc(a.name || '')}" placeholder="e.g. Win back overdue monthly shoppers" /></div>
    <div class="inline-fields"><div class="field"><label>Target segment</label>${segSelect('aseg', a.segment || 'OVERDUE', { all: '' })}</div>
      <div class="field"><label>Reward (personalised offer at any business)</label><select id="aof">${personal.map((o) => `<option value="${o.id}" ${a.offer_id === o.id ? 'selected' : ''}>${esc(offerLabel(o))}</option>`).join('') || '<option value="">No personalised offers yet</option>'}</select></div></div>
    <div class="inline-fields"><div class="field"><label>Reward valid for (days)</label><input id="avd" inputmode="numeric" value="${a.reward_valid_days}" /></div>
      <div class="field"><label>Cooldown before targeting again (days)</label><input id="acd" inputmode="numeric" value="${a.cooldown_days}" /></div>
      <div class="field"><label>Recovery window (days)</label><input id="awd" inputmode="numeric" value="${a.window_days}" /></div></div>
    <div class="field"><label>Notification message</label><input id="amsg" value="${esc(a.message || '')}" placeholder="We miss you! Here's ₹75 off your next visit" /></div>
    <label class="chk"><input type="checkbox" id="aac" ${a.active ? 'checked' : ''} /> Active (runs after every upload and nightly)</label>
    <div id="apv" class="alert info small" style="margin-top:10px">Use Preview to see how many customers this would target now.</div>
    <div class="row" style="margin-top:12px"><button id="apb">Preview</button><button class="btn-primary" id="as">Save</button><button data-close>Cancel</button></div>`, { wide: true });
  const body = () => ({ id: a.id, name: $('#an', m.el).value, segment: $('#aseg', m.el).value, offer_id: Number($('#aof', m.el).value) || null, reward_valid_days: $('#avd', m.el).value,
    cooldown_days: $('#acd', m.el).value, window_days: $('#awd', m.el).value, message: $('#amsg', m.el).value, active: $('#aac', m.el).checked });
  const pb = $('#apb', m.el);
  pb.onclick = busy(pb, async () => {
    const r = await api.post('/admin/automations/preview', body());
    $('#apv', m.el).textContent = `${num(r.would_target)} of ${num(r.segment_size)} customers in this segment would get the reward now (the rest were targeted within the cooldown).`;
  });
  const s = $('#as', m.el);
  s.onclick = busy(s, async () => {
    const b = body();
    if (b.active && !confirm('Active automations send rewards automatically after every upload and nightly. Save and activate?')) return;
    if (a.id) await api.put(`/admin/automations/${a.id}`, b); else await api.post('/admin/automations', b);
    toast('Automation saved');
    m.close();
    done();
  });
}

function programForm(p, personal, done) {
  const today = todayIST();
  p = p || { qualify_days: 30, max_referrals: 10, max_per_day: 3, new_customer_days: 30, reward_valid_days: 30, active: 1, valid_from: today };
  const m = modal(`<h2>${p.id ? `Edit ${esc(p.name)}` : 'New referral programme'}</h2>
    <div class="inline-fields"><div class="field"><label>Name</label><input id="pn" value="${esc(p.name || 'Refer a friend')}" /></div>
      <div class="field"><label>Valid from</label><input type="date" id="pf" value="${p.valid_from || today}" /></div><div class="field"><label>Valid to</label><input type="date" id="pt" value="${p.valid_to || ''}" /></div></div>
    <div class="inline-fields"><div class="field"><label>Minimum first Vasantham bill (₹)</label><input id="pmin" inputmode="decimal" value="${p.min_purchase_paise ? p.min_purchase_paise / 100 : ''}" placeholder="0" /></div>
      <div class="field"><label>Must qualify within (days)</label><input id="pq" inputmode="numeric" value="${p.qualify_days}" /></div>
      <div class="field"><label>Rewards valid for (days)</label><input id="prv" inputmode="numeric" value="${p.reward_valid_days}" /></div></div>
    <h3>Existing customer (referrer) gets</h3>${rewardFields('rr', { type: p.referrer_reward_type, cp: p.referrer_cp, offer_id: p.referrer_offer_id }, personal)}
    <h3>New customer gets (welcome reward)</h3>${rewardFields('re', { type: p.referee_reward_type || 'OFFER', cp: p.referee_cp, offer_id: p.referee_offer_id }, personal)}
    <h3>Fraud prevention</h3>
    <div class="inline-fields"><div class="field"><label>Max referrals per customer</label><input id="pmax" inputmode="numeric" value="${p.max_referrals}" /></div>
      <div class="field"><label>Max referrals per customer per day</label><input id="pday" inputmode="numeric" value="${p.max_per_day}" /></div>
      <div class="field"><label>New customer: joined within (days)</label><input id="pnew" inputmode="numeric" value="${p.new_customer_days}" /></div></div>
    <p class="tiny muted">Always enforced: one account per mobile (OTP), a customer can be referred only once and must have no purchases, no self-referral or A↔B loops, the referrer must be an active shopper, and admins can reject pending referrals.</p>
    <label class="chk"><input type="checkbox" id="pac" ${p.active ? 'checked' : ''} /> Active</label>
    <div class="row" style="margin-top:12px"><button class="btn-primary" id="ps">Save</button><button data-close>Cancel</button></div>`, { wide: true });
  wireReward(m.el, 'rr');
  wireReward(m.el, 're');
  const s = $('#ps', m.el);
  s.onclick = busy(s, async () => {
    const body = { name: $('#pn', m.el).value, valid_from: $('#pf', m.el).value, valid_to: $('#pt', m.el).value, min_purchase: $('#pmin', m.el).value, qualify_days: $('#pq', m.el).value,
      reward_valid_days: $('#prv', m.el).value, referrer_reward: readReward(m.el, 'rr'), referee_reward: readReward(m.el, 're'), max_referrals: $('#pmax', m.el).value,
      max_per_day: $('#pday', m.el).value, new_customer_days: $('#pnew', m.el).value, active: $('#pac', m.el).checked };
    if (p.id) await api.put(`/admin/referrals/programs/${p.id}`, body); else await api.post('/admin/referrals/programs', body);
    toast('Referral programme saved');
    m.close();
    done();
  });
}

/* ---------------- views ---------------- */
const VIEWS = {
  async growth(el) {
    const preset = $('#gp')?.value || 'this-month';
    const range = periodRange(preset, $('#gf')?.value, $('#gt')?.value);
    const f = { from: range.from, to: range.to, business: $('#gb')?.value ?? '' };
    const g = await api.get(`/admin/growth?${qs(f)}`);
    const k = g.key_metric;
    const R = g.redemptions;
    const x = (v) => (v == null ? '—' : `${v.toFixed(1)}×`);
    const rate = (v) => (v == null ? '—' : pct(v));
    const scoped = !!g.business_id;
    el.innerHTML = `
      ${head(scoped ? `Growth · ${esc(g.business_name)}` : 'Ecosystem growth')}
      <div class="filters">
        <select id="gp">${[['this-week', 'This week'], ['last-week', 'Last week'], ['this-month', 'This month'], ['last-month', 'Last month'], ['custom', 'Custom period']]
          .map(([v, l]) => `<option value="${v}" ${preset === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="date" id="gf" value="${f.from}" ${preset === 'custom' ? '' : 'disabled'} /><input type="date" id="gt" value="${f.to}" ${preset === 'custom' ? '' : 'disabled'} />
        ${me.business_id ? '' : `<select id="gb">${bizOptions(f.business, 'All businesses')}</select>`}<button class="btn-primary" id="ggo">Show</button>
      </div>

      <div class="card hero-metric">
        <div class="label">Revenue associated with redemption ÷ reward value used</div>
        <div class="hero">${x(k.ratio)}</div>
        <div class="small">${inr(k.linked_revenue_paise)} of bills where a reward was used ÷ ${inr(k.reward_value_paise)} of points and rewards used</div>
        <div class="tiny muted" style="margin-top:4px">${esc(k.note)}</div>
      </div>

      ${g.customers ? `<h2 class="gh">Customers</h2><div class="grid k4">
        ${kpi('Loyalty customers', num(g.customers.total), `${num(g.customers.new_members)} joined in period · ${num(g.customers.app_users)} use the app`)}
        ${kpi('Active customers', num(g.customers.active), 'bought or redeemed in the period')}
        ${kpi('Visits per shopper', g.customers.visits_per_shopper == null ? '—' : g.customers.visits_per_shopper.toFixed(1), `${num(g.customers.bills)} Vasantham bills · ${num(g.customers.shoppers)} shoppers`)}
        ${kpi('Spend per shopper', g.customers.spend_per_shopper_paise == null ? '—' : inr(g.customers.spend_per_shopper_paise), `${inr(g.customers.member_revenue_paise)} member revenue`)}
      </div>` : ''}

      <h2 class="gh">Redemptions &amp; rewards</h2>
      <div class="grid k4">
        ${kpi('Redemptions', num(R.redemptions), `${num(R.customers)} customers · ${num(R.rewards)} rewards`)}
        ${kpi('Reward value used', inr(R.reward_value_paise), `Points ${inr(R.points_value_paise)} · rewards ${inr(R.reward_face_paise)}`)}
        ${kpi('Reward cost', inr(R.reward_cost_paise), `Partner-funded ${inr(R.partner_funded_paise)}`)}
        ${kpi('Average bill with a reward', R.avg_linked_bill_paise == null ? '—' : inr(R.avg_linked_bill_paise),
          g.customers?.avg_bill_without_reward_paise != null ? `Vasantham bills without a reward: ${inr(g.customers.avg_bill_without_reward_paise)}` : `${num(R.linked_bills)} bills`)}
        ${g.customers ? kpi('Redemption rate', rate(g.customers.redemption_rate), 'active customers who redeemed') : ''}
        ${g.customers ? kpi('Points redeemed ÷ earned', rate(g.customers.points_redemption_rate), `${pts(g.customers.points_redeemed_cp)} of ${pts(g.customers.points_earned_cp)} points`) : ''}
        ${kpi('Repeat after first redemption', rate(g.repeat.repeat_rate), `${num(g.repeat.repeated)} of ${num(g.repeat.first_redeemers)} came back`)}
        ${kpi(scoped ? 'Customers from the ecosystem' : 'Vasantham customers redeeming elsewhere', num(scoped ? g.first_time.reduce((s, r) => s + (r.via_redemption || 0), 0) : g.ecosystem.vasantham_shoppers),
          scoped ? 'first came here to use a reward' : `${num(g.ecosystem.multi_business)} customers used 2+ businesses`)}
      </div>

      ${g.customers ? `<h2 class="gh">Engagement</h2><div class="grid k4">
        ${kpi('Dormant customers recovered', num(g.recovery.win_backs), `bought again after ${g.recovery.gap_days}+ days away`)}
        ${kpi('Reactivation recovery', rate(g.recovery.recovery_rate), `${num(g.recovery.recovered)} of ${num(g.recovery.targeted)} targeted`)}
        ${kpi('Referral conversions', num(g.referrals.converted_in_period), `${num(g.referrals.created)} new referrals · ${rate(g.referrals.conversion_rate)} converted`)}
        ${kpi('Milestone completion', rate(g.milestone_completion.completion_rate), `${num(g.milestone_completion.completers)} of ${num(g.milestone_completion.participants)} participants`)}
        ${kpi('Visit challenge completion', rate(g.visit_completion.completion_rate), `${num(g.visit_completion.completers)} of ${num(g.visit_completion.participants)} participants`)}
      </div>` : ''}

      <h2 class="gh">Revenue ÷ reward value, last 6 months</h2>
      <div class="card">${ratioChart(g.trend)}
        <details class="small" style="margin-top:8px"><summary>Table view</summary>
          <table style="margin-top:6px"><tr><th>Month</th><th class="num">${scoped ? 'Redeeming customers' : 'Active shoppers'}</th><th class="num">Redemptions</th><th class="num">Reward value used</th><th class="num">Revenue with a reward</th><th class="num">Ratio</th></tr>
          ${g.trend.map((t) => `<tr><td>${esc(monthName(t.month))}</td><td class="num">${num(t.active_customers)}</td><td class="num">${num(t.redemptions)}</td><td class="num">${inr(t.reward_value_paise)}</td><td class="num">${inr(t.linked_revenue_paise)}</td><td class="num">${x(t.ratio)}</td></tr>`).join('')}</table></details>
      </div>

      <h2 class="gh">By business</h2>
      <div class="table-wrap"><table><tr><th>Business</th><th class="num">Redemptions</th><th class="num">Customers</th><th class="num">Reward value used</th><th class="num">Reward cost</th>
          <th class="num">Revenue with a reward</th><th class="num">Avg bill</th><th class="num">Revenue ÷ reward</th><th class="num">First-time customers</th></tr>
        ${g.per_business.map((b) => {
          const ft = g.first_time.find((f) => f.business_id === b.business_id) || {};
          return `<tr><td><b>${esc(b.name)}</b></td><td class="num">${num(b.redemptions)}</td><td class="num">${num(b.customers)}</td><td class="num">${inr(b.reward_value_paise)}</td>
            <td class="num">${inr(b.reward_cost_paise)}</td><td class="num">${inr(b.linked_revenue_paise)}</td><td class="num">${b.avg_linked_bill_paise == null ? '—' : inr(b.avg_linked_bill_paise)}</td>
            <td class="num"><b>${x(b.revenue_to_reward)}</b></td><td class="num">${num(ft.first_time || 0)}<div class="tiny muted">${num(ft.via_redemption || 0)} via a reward</div></td></tr>`;
        }).join('')}</table></div>
      <p class="tiny muted">First-time customers: customers whose first activity with that business (a purchase, or using a reward there) was in this period.</p>

      ${g.movement.length ? `<h2 class="gh">Cross-business customer movement</h2>
        <div class="table-wrap"><table><tr><th>Partner</th><th class="num">Customers redeeming there</th><th class="num">Also shopped at Vasantham</th><th class="num">Also used another partner</th></tr>
          ${g.movement.map((m) => `<tr><td><b>${esc(m.name)}</b></td><td class="num">${num(m.customers)}</td><td class="num">${num(m.also_vasantham)} <span class="tiny muted">${rate(m.customers ? m.also_vasantham / m.customers : null)}</span></td>
            <td class="num">${num(m.also_other_partners)}</td></tr>`).join('')}</table></div>` : ''}

      ${g.challenges?.length ? `<h2 class="gh">Milestones &amp; challenges</h2>
        <div class="table-wrap"><table><tr><th>Challenge</th><th class="num">Participants</th><th class="num">Reached a reward</th><th class="num">Completion</th><th class="num">Rewards given</th></tr>
          ${g.challenges.map((c) => `<tr><td>${esc(c.name)} <span class="tiny muted">${c.type === 'SPEND' ? 'spend' : 'visits'}</span></td><td class="num">${num(c.participants)}</td><td class="num">${num(c.completers)}</td><td class="num">${rate(c.completion_rate)}</td><td class="num">${num(c.awards)}</td></tr>`).join('')}</table></div>` : ''}

      ${g.campaigns?.length ? `<h2 class="gh">Campaign performance</h2>
        <div class="table-wrap"><table><tr><th>Campaign</th><th>Reward at</th><th class="num">Audience</th><th class="num">Came back</th><th class="num">Redeemed</th><th class="num">Revenue</th><th class="num">Cost</th></tr>
          ${g.campaigns.map((c) => `<tr class="click" data-cmp="${c.id}"><td><b>${esc(c.name)}</b><div class="tiny muted">${esc(segName(c.segment))}</div></td><td class="small">${esc(c.business || '')}</td>
            <td class="num">${num(c.audience)}</td><td class="num">${num(c.returned)} <span class="tiny muted">${rate(c.return_rate)}</span></td><td class="num">${num(c.redeemed)} <span class="tiny muted">${rate(c.redemption_rate)}</span></td>
            <td class="num">${inr(c.revenue_paise)}</td><td class="num">${inr(c.cost_paise)}</td></tr>`).join('')}</table></div>` : ''}`;
    const reload = () => VIEWS.growth(el);
    $('#gp').onchange = () => { if ($('#gp').value !== 'custom') reload(); else { $('#gf').disabled = false; $('#gt').disabled = false; } };
    $('#ggo').onclick = reload;
    $$('[data-cmp]', el).forEach((tr) => (tr.onclick = () => { location.hash = `#/campaign/${tr.dataset.cmp}`; }));
    bindChartTips(el);
  },

  async challenges(el) {
    const [list, meta, offersAll] = await Promise.all([api.get('/admin/challenges'), api.get('/admin/challenges/meta'), api.get('/admin/offers')]);
    const personal = offersAll.filter((o) => o.audience === 'PERSONAL' && o.active);
    el.innerHTML = `
      ${head('Milestones & challenges', '<button class="btn-primary" id="nsp">New spend milestone</button><button id="nvi">New visit challenge</button>')}
      <p class="small muted">Progress comes from the daily Excel upload. Rewards (bonus points, or a personalised offer / coupon at any business) are given automatically after each upload, once per tier per period.
        Offers used as rewards must be <b>personalised</b> (Offers → New offer → Audience: Personalised).</p>
      <div class="stack">${list.map((c) => `
        <div class="card">
          <div class="row between"><div><h3 style="margin:0">${esc(c.name)} ${c.active ? '<span class="badge green">Active</span>' : '<span class="badge">Inactive</span>'}</h3>
            <div class="small muted">${esc(c.type_label)} · ${esc(c.period_label)} · ${esc(c.business_name)} · ${esc(c.segment_label)}${c.type === 'VISITS' && c.min_bill_paise ? ` · min bill ${inr(c.min_bill_paise)}` : ''}
              · ${dateOnly(c.valid_from)} – ${dateOnly(c.valid_to)}${c.repeatable ? '' : ' · once per customer'}</div></div>
            <div class="row"><button class="btn-sm" data-ce="${c.id}">Edit</button><button class="btn-sm" data-ct="${c.id}" data-on="${c.active}">${c.active ? 'Deactivate' : 'Activate'}</button></div></div>
          <div class="grid k4" style="margin-top:10px">
            ${kpi('Eligible customers', num(c.eligible))}
            ${kpi('Taking part this period', num(c.participants), `${dateOnly(c.current_period.from)} – ${dateOnly(c.current_period.to)}`)}
            ${kpi('Completion rate', pct(c.completion_rate), `${num(c.completers_all)} of ${num(c.participants_all)} participants reached a reward`)}
            ${kpi('Rewards given', `${pts(c.points_given_cp)} pts`, `${num(c.offers_unlocked)} offers unlocked`)}
          </div>
          <table style="margin-top:10px"><tr><th>Target</th><th>Reward</th><th class="num">This period</th><th class="num">All time</th></tr>
            ${c.tiers.map((t) => `<tr><td><b>${esc(t.label)}</b></td><td>${esc(t.reward)}${t.reward_type === 'OFFER' ? ` <span class="tiny muted">valid ${t.reward_valid_days} days</span>` : ''}</td><td class="num">${num(t.awarded_now)}</td><td class="num">${num(t.awarded_total)}</td></tr>`).join('')}</table>
        </div>`).join('') || '<div class="empty card">No challenges yet.</div>'}</div>`;
    const reload = () => VIEWS.challenges(el);
    $('#nsp').onclick = () => challengeForm({ type: 'SPEND' }, meta, personal, reload);
    $('#nvi').onclick = () => challengeForm({ type: 'VISITS' }, meta, personal, reload);
    $$('[data-ce]', el).forEach((b) => (b.onclick = () => challengeForm(list.find((c) => c.id === Number(b.dataset.ce)), meta, personal, reload)));
    $$('[data-ct]', el).forEach((b) => (b.onclick = busy(b, async () => { await api.put(`/admin/challenges/${b.dataset.ct}`, { active: b.dataset.on !== '1' }); reload(); })));
  },

  async reactivation(el) {
    const [list, offersAll] = await Promise.all([api.get('/admin/automations'), api.get('/admin/offers')]);
    const personal = offersAll.filter((o) => o.audience === 'PERSONAL' && o.active);
    el.innerHTML = `
      ${head('Reactivation', '<button class="btn-primary" id="na">New automation</button>')}
      <p class="small muted">Automatically send a personalised reward (at Vasantham or any partner) to customers who enter a segment such as <b>Overdue</b>, <b>Dormant</b>, <b>Lost</b>,
        <b>Spend decline</b> or <b>Frequency decline</b>. Runs after every Excel upload and nightly. A customer is targeted again only after the cooldown.
        <b>Recovered</b> = bought at Vasantham within the window after being targeted.</p>
      <div class="table-wrap"><table><tr><th>Automation</th><th>Reward</th><th class="num">Targeted</th><th class="num">Recovered</th><th class="num">Revenue after</th><th class="num">Reward used</th><th class="num">Due now</th><th></th></tr>
        ${list.map((a) => `<tr><td><b>${esc(a.name)}</b> ${a.active ? '<span class="badge green">On</span>' : '<span class="badge">Off</span>'}
            <div class="tiny muted">${esc(a.segment_label)} · cooldown ${a.cooldown_days} d · window ${a.window_days} d${a.last_run_at ? ` · last run ${dt(a.last_run_at)}` : ''}</div></td>
          <td class="small">${esc(a.offer_title)}<div class="tiny muted">${esc(a.business_name)} · valid ${a.reward_valid_days} d</div></td>
          <td class="num">${num(a.targeted)}</td><td class="num"><b>${num(a.recovered)}</b><div class="tiny muted">${pct(a.recovery_rate)}${a.still_in_window ? ` · ${num(a.still_in_window)} in window` : ''}</div></td>
          <td class="num">${inr(a.revenue_paise)}</td><td class="num">${num(a.redemptions)}<div class="tiny muted">cost ${inr(a.reward_cost_paise)}</div></td><td class="num">${num(a.would_target_now)}</td>
          <td class="right" style="white-space:nowrap"><button class="btn-sm" data-ae="${a.id}">Edit</button> <button class="btn-sm btn-primary" data-ar="${a.id}">Run now</button></td></tr>`).join('')
          || '<tr><td colspan="8" class="empty">No automations yet</td></tr>'}</table></div>`;
    const reload = () => VIEWS.reactivation(el);
    $('#na').onclick = () => automationForm(null, personal, reload);
    $$('[data-ae]', el).forEach((b) => (b.onclick = () => automationForm(list.find((a) => a.id === Number(b.dataset.ae)), personal, reload)));
    $$('[data-ar]', el).forEach((b) => (b.onclick = busy(b, async () => {
      const a = list.find((x) => x.id === Number(b.dataset.ar));
      if (!confirm(`Send "${a.offer_title}" to ${a.would_target_now} customers now?`)) return;
      const r = await api.post(`/admin/automations/${a.id}/run`, {});
      toast(`${r.targeted} customers targeted`);
      reload();
    })));
  },

  async referrals(el) {
    const f = { status: $('#rfs')?.value ?? '' };
    const [d, offersAll] = await Promise.all([api.get(`/admin/referrals?${qs(f)}`), api.get('/admin/offers')]);
    const personal = offersAll.filter((o) => o.audience === 'PERSONAL' && o.active);
    const today = todayIST();
    el.innerHTML = `
      ${head('Referrals', '<button class="btn-primary" id="np">New programme</button>')}
      <div class="stack">${d.programs.map((p) => `
        <div class="card"><div class="row between"><div><h3 style="margin:0">${esc(p.name)} ${p.active && p.valid_from <= today && p.valid_to >= today ? '<span class="badge green">Running</span>' : '<span class="badge">Not running</span>'}</h3>
          <div class="small muted">${dateOnly(p.valid_from)} – ${dateOnly(p.valid_to)} · referrer gets <b>${esc(p.referrer_reward)}</b> · new customer gets <b>${esc(p.referee_reward)}</b>
            · first bill ${esc(p.min_purchase || 'any amount')} within ${p.qualify_days} days · max ${p.max_referrals} per customer, ${p.max_per_day}/day · referee must be new (≤ ${p.new_customer_days} days, no purchases)</div></div>
          <button class="btn-sm" data-pe="${p.id}">Edit</button></div>
          <div class="grid k4" style="margin-top:10px">${kpi('Referrals', num(p.stats.total))}${kpi('Converted', num(p.stats.rewarded || 0), p.stats.total ? pct((p.stats.rewarded || 0) / p.stats.total) : '')}
            ${kpi('Pending', num(p.stats.pending || 0))}${kpi('Rejected / expired', num((p.stats.rejected || 0) + (p.stats.expired || 0)))}</div></div>`).join('') || '<div class="empty card">No referral programme yet.</div>'}</div>
      <div class="row between" style="margin:18px 0 8px"><h2 style="margin:0">Referrals</h2>
        <select id="rfs" style="width:auto">${['', 'PENDING', 'REWARDED', 'REJECTED', 'EXPIRED'].map((s) => `<option value="${s}" ${f.status === s ? 'selected' : ''}>${s || 'All statuses'}</option>`).join('')}</select></div>
      <div class="table-wrap"><table><tr><th>Date</th><th>Referrer</th><th>New customer</th><th>Status</th><th>Qualifying bill</th><th></th></tr>
        ${d.rows.map((r) => `<tr><td class="small">${dt(r.created_at)}</td><td>${esc(r.referrer_mobile)}<div class="tiny muted">${esc(r.referrer_name || '')} · ${esc(r.code)}</div></td>
          <td>${esc(r.referee_mobile)}<div class="tiny muted">${esc(r.referee_name || '')}</div></td>
          <td><span class="badge ${r.status === 'REWARDED' ? 'green' : r.status === 'PENDING' ? 'warn' : ''}">${esc(r.status)}</span>${r.reason ? `<div class="tiny muted">${esc(r.reason)}</div>` : ''}</td>
          <td class="small">${r.qualifying_paise ? `${inr(r.qualifying_paise)} · ${dateOnly(r.qualifying_date)}` : ''}</td>
          <td class="right">${r.status === 'PENDING' ? `<button class="btn-sm btn-danger" data-rj="${r.id}">Reject</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No referrals</td></tr>'}</table></div>
      ${d.top.length ? `<h2 style="margin-top:18px">Top referrers</h2><div class="table-wrap"><table><tr><th>Customer</th><th class="num">Referrals</th><th class="num">Converted</th></tr>
        ${d.top.map((t) => `<tr><td>${esc(t.mobile)} <span class="tiny muted">${esc(t.name || '')}</span></td><td class="num">${num(t.referrals)}</td><td class="num">${num(t.converted)}</td></tr>`).join('')}</table></div>` : ''}`;
    const reload = () => VIEWS.referrals(el);
    $('#rfs').onchange = reload;
    $('#np').onclick = () => programForm(null, personal, reload);
    $$('[data-pe]', el).forEach((b) => (b.onclick = () => programForm(d.programs.find((p) => p.id === Number(b.dataset.pe)), personal, reload)));
    $$('[data-rj]', el).forEach((b) => (b.onclick = busy(b, async () => {
      const reason = prompt('Reason for rejecting this referral (e.g. suspected duplicate account):');
      if (!reason) return;
      await api.post(`/admin/referrals/${b.dataset.rj}/reject`, { reason });
      toast('Referral rejected');
      reload();
    })));
  },

  async interests(el) {
    const list = await api.get('/admin/interest-segments');
    el.innerHTML = `
      ${head('Interest segments', '<button class="btn-primary" id="ni">New interest segment</button>')}
      <p class="small muted">Rules that group customers by what they buy at Vasantham, so partner offers reach the right people, e.g. nuts, seeds and health foods → MF Nuts;
        snacks, beverages and frozen food → House of Friez; home-care → Afya Mart. Use them in <b>Offers → Show only to segments</b>, campaigns, challenges and reactivation.
        Needs item-level Excel data (Product / Category columns).</p>
      <div class="table-wrap"><table><tr><th>Segment</th><th>Categories</th><th>Product keywords</th><th>Rule</th><th class="num">Customers</th><th></th></tr>
        ${list.map((i) => `<tr><td><b>${esc(i.name)}</b> ${i.active ? '' : '<span class="badge">Off</span>'}<div class="tiny muted">INT:${esc(i.code)}</div></td><td class="small">${esc(i.categories || '—')}</td>
          <td class="small">${esc(i.keywords || '—')}</td><td class="small">≥ ${Math.round(i.min_share * 100)}% of basket${i.min_spend_paise ? ` and ≥ ${inr(i.min_spend_paise)}` : ''} in ${i.lookback_days} days</td>
          <td class="num">${num(i.customers)}</td><td class="right"><button class="btn-sm" data-ie="${i.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No interest segments yet</td></tr>'}</table></div>`;
    const reload = async () => { segOptions = await api.get('/admin/segments/options'); VIEWS.interests(el); };
    const form = (i) => {
      const m = modal(`<h2>${i ? `Edit ${esc(i.name)}` : 'New interest segment'}</h2>
        <div class="inline-fields"><div class="field"><label>Name</label><input id="in" value="${esc(i?.name || '')}" placeholder="e.g. Nuts & health foods" /></div>
          <div class="field"><label>Code</label><input id="ic" value="${esc(i?.code || '')}" ${i ? 'disabled' : ''} placeholder="e.g. NUTS" /></div></div>
        <div class="field"><label>Categories (comma separated, as in the Excel Category column)</label><input id="icat" value="${esc(i?.categories || '')}" placeholder="Dry Fruits, Health Foods" /></div>
        <div class="field"><label>Product name keywords (comma separated)</label><input id="ikw" value="${esc(i?.keywords || '')}" placeholder="almond, cashew, seeds, oats" /></div>
        <div class="inline-fields"><div class="field"><label>Minimum share of basket (%)</label><input id="ish" inputmode="decimal" value="${i ? Math.round(i.min_share * 100) : 15}" /></div>
          <div class="field"><label>Minimum spend on these (₹)</label><input id="isp" inputmode="decimal" value="${i?.min_spend_paise ? i.min_spend_paise / 100 : ''}" placeholder="0" /></div>
          <div class="field"><label>Look-back (days)</label><input id="ilb" inputmode="numeric" value="${i?.lookback_days || 90}" /></div></div>
        <label class="chk"><input type="checkbox" id="iac" ${!i || i.active ? 'checked' : ''} /> Active</label>
        <div class="row" style="margin-top:12px"><button class="btn-primary" id="is">Save</button><button data-close>Cancel</button></div>`);
      const s = $('#is', m.el);
      s.onclick = busy(s, async () => {
        const body = { name: $('#in', m.el).value, code: $('#ic', m.el).value, categories: $('#icat', m.el).value, keywords: $('#ikw', m.el).value,
          min_share_pct: $('#ish', m.el).value, min_spend: $('#isp', m.el).value, lookback_days: $('#ilb', m.el).value, active: $('#iac', m.el).checked };
        if (i) await api.put(`/admin/interest-segments/${i.id}`, body); else await api.post('/admin/interest-segments', body);
        toast('Saved; segments recalculated');
        m.close();
        reload();
      });
    };
    $('#ni').onclick = () => form(null);
    $$('[data-ie]', el).forEach((b) => (b.onclick = () => form(list.find((i) => i.id === Number(b.dataset.ie)))));
  },

  async businesses(el) {
    businesses = await api.get('/admin/businesses');
    el.innerHTML = `
      ${head('Businesses / Partners', '<button class="btn-primary" id="newb">Add business</button>')}
      <p class="small muted">Every business in the Vasantham Rewards ecosystem. <b>Earn</b>: purchases there earn loyalty points. <b>Redeem</b>: customers can use points and rewards there.
        Each business has its own redemption rules, outlets and settlement account.</p>
      <div class="biz-grid">${businesses.map(bizCard).join('')}</div>`;
    $('#newb').onclick = () => businessForm(null, () => VIEWS.businesses(el));
    $$('[data-biz]', el).forEach((b) => (b.onclick = () => businessForm(businesses.find((x) => x.id === Number(b.dataset.biz)), () => VIEWS.businesses(el))));
  },

  async settlements(el) {
    const preset = $('#sp')?.value || 'this-month';
    const range = periodRange(preset, $('#sf')?.value, $('#st')?.value);
    const f = { from: range.from, to: range.to, business: $('#sb')?.value ?? '' };
    const [rep, list] = await Promise.all([api.get(`/admin/settlements/report?${qs(f)}`), api.get(`/admin/settlements?${qs({ business: f.business })}`)]);
    const t = rep.totals;
    const money = (p) => `<span class="${p < 0 ? 'neg' : ''}">${inr(p)}</span>`;
    el.innerHTML = `
      ${head('Cross-business settlement')}
      <p class="small muted">When points or rewards are used at a business, the Vasantham loyalty fund owes that business the funded amount (<b>payable</b>).
        When a partner funds a reward that is used elsewhere, the partner owes the fund its share (<b>receivable</b>). Each business is accounted separately.
        Only redemptions whose bill is confirmed (Excel upload or outlet confirmation) can be settled.</p>
      <div class="filters">
        <select id="sp">${[['this-week', 'This week'], ['last-week', 'Last week'], ['this-month', 'This month'], ['last-month', 'Last month'], ['custom', 'Custom period']]
          .map(([k, l]) => `<option value="${k}" ${preset === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="date" id="sf" value="${f.from}" ${preset === 'custom' ? '' : 'disabled'} /><input type="date" id="st" value="${f.to}" ${preset === 'custom' ? '' : 'disabled'} />
        <select id="sb">${bizOptions(f.business)}</select><button class="btn-primary" id="sgo">Show</button>
      </div>
      <div class="grid k4" style="margin-bottom:14px">
        ${kpi('Redemptions', num(t.redemptions), `${num(t.rewards)} rewards · ${pts(t.points_cp)} points`)}
        ${kpi('Reward value used', inr(t.points_value_paise + t.reward_value_paise), `Points ${inr(t.points_value_paise)} · rewards ${inr(t.reward_value_paise)}`)}
        ${kpi('Promotional reward cost', inr(t.reward_cost_paise), `Fund ${inr(t.program_funded_paise - t.points_value_paise)} · partners ${inr(t.partner_funded_paise)}`)}
        ${kpi('Settlement payable', inr(t.payable_paise), `Receivable ${inr(t.receivable_paise)}`)}
        ${kpi('Settled', inr(t.settled_paise))}
        ${kpi('Pending', inr(t.pending_paise), `${inr(t.ready_to_settle_paise)} ready · ${inr(t.awaiting_billing_paise)} awaiting billing`)}
      </div>
      <div class="table-wrap"><table>
        <tr><th>Business</th><th class="num">Redemptions</th><th class="num">Points used</th><th class="num">Reward value</th><th class="num">Reward cost<br/><span class="tiny">fund / partner</span></th>
          <th class="num">Payable</th><th class="num">Receivable</th><th class="num">Net</th><th class="num">Settled</th><th class="num">Awaiting billing</th><th class="num">Ready to settle</th><th></th></tr>
        ${rep.rows.map((r) => `<tr><td><b>${esc(r.name)}</b><div class="tiny muted">${esc(r.code)} · ${esc(r.settlement_cycle.toLowerCase())}${r.is_program_owner ? ' · program owner' : ''}</div></td>
          <td class="num">${num(r.redemptions)}</td><td class="num">${pts(r.points_cp)}<div class="tiny muted">${inr(r.points_value_paise)}</div></td><td class="num">${inr(r.reward_value_paise)}</td>
          <td class="num">${inr(r.reward_cost_paise)}<div class="tiny muted">${inr(r.program_funded_paise - r.points_value_paise)} / ${inr(r.partner_funded_paise)}</div></td>
          <td class="num">${inr(r.payable_paise)}</td><td class="num">${inr(r.receivable_paise)}</td><td class="num"><b>${money(r.net_paise)}</b></td><td class="num">${inr(r.settled_paise)}</td>
          <td class="num">${money(r.awaiting_billing_paise)}</td><td class="num"><b>${money(r.ready_to_settle_paise)}</b></td>
          <td class="right" style="white-space:nowrap"><button class="btn-sm" data-open="${r.business_id}">Lines</button>
            ${r.ready_to_settle_paise ? `<button class="btn-sm btn-primary" data-settle="${r.business_id}">Create settlement</button>` : ''}</td></tr>`).join('')}
      </table></div>
      <p class="tiny muted">Net = payable − receivable. A positive net is paid by the loyalty fund to the business; a negative net (e.g. after a reversal) is owed by the business to the fund.</p>
      <h2 style="margin-top:20px">Settlements</h2>
      <div class="table-wrap"><table><tr><th>#</th><th>Business</th><th>Period</th><th class="num">Payable</th><th class="num">Receivable</th><th class="num">Net</th><th>Status</th><th>Settled</th><th></th></tr>
        ${list.map((s) => `<tr><td>${s.id}</td><td>${esc(s.business_name)}</td><td class="small">${dateOnly(s.period_from)} – ${dateOnly(s.period_to)}<div class="tiny muted">${num(s.txn_count)} lines · ${esc(s.created_by_name || '')}</div></td>
          <td class="num">${inr(s.payable_paise)}</td><td class="num">${inr(s.receivable_paise)}</td><td class="num"><b>${money(s.net_paise)}</b></td>
          <td><span class="badge ${s.status === 'SETTLED' ? 'green' : s.status === 'VOID' ? '' : 'warn'}">${esc(s.status)}</span></td>
          <td class="small">${s.status === 'SETTLED' ? `${inr(s.settled_paise)} · ${esc(s.reference || '')}<div class="tiny muted">${dt(s.settled_at)} · ${esc(s.settled_by_name || '')}</div>` : esc(s.note || '')}</td>
          <td class="right" style="white-space:nowrap"><button class="btn-sm" data-sv="${s.id}">View</button>
            ${s.status === 'OPEN' ? `<button class="btn-sm btn-primary" data-paid="${s.id}">Mark settled</button> <button class="btn-sm" data-void="${s.id}">Void</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No settlements yet</td></tr>'}
      </table></div>`;
    const reload = () => VIEWS.settlements(el);
    $('#sp').onchange = () => { if ($('#sp').value !== 'custom') reload(); else { $('#sf').disabled = false; $('#st').disabled = false; } };
    $('#sgo').onclick = reload;
    $$('[data-open]', el).forEach((b) => (b.onclick = busy(b, async () => {
      const rows = await api.get(`/admin/settlements/open?${qs({ business: b.dataset.open, from: f.from, to: f.to })}`);
      modal(`<div class="row between"><h2>Unsettled lines · ${esc(bizName(b.dataset.open))}</h2><button data-close class="btn-sm">Close</button></div>${settlementLines(rows)}`, { wide: true });
    })));
    $$('[data-settle]', el).forEach((b) => (b.onclick = busy(b, async () => {
      const name = bizName(b.dataset.settle);
      if (!confirm(`Create a settlement for ${name}, ${dateOnly(f.from)} – ${dateOnly(f.to)}? Only billing-confirmed lines are included.`)) return;
      const s = await api.post('/admin/settlements', { business_id: Number(b.dataset.settle), from: f.from, to: f.to });
      toast(`Settlement #${s.id} created: net ${inr(s.net_paise)}`);
      reload();
    })));
    $$('[data-sv]', el).forEach((b) => (b.onclick = busy(b, async () => {
      const s = await api.get(`/admin/settlements/${b.dataset.sv}`);
      modal(`<div class="row between"><h2>Settlement #${s.id} · ${esc(s.business_name)}</h2><button data-close class="btn-sm">Close</button></div>
        <p class="small">${dateOnly(s.period_from)} – ${dateOnly(s.period_to)} · Payable ${inr(s.payable_paise)} · Receivable ${inr(s.receivable_paise)} · <b>Net ${inr(s.net_paise)}</b> · ${esc(s.status)}${s.reference ? ` · Ref ${esc(s.reference)}` : ''}</p>
        ${settlementLines(s.transactions)}`, { wide: true });
    })));
    $$('[data-paid]', el).forEach((b) => (b.onclick = () => {
      const s = list.find((x) => x.id === Number(b.dataset.paid));
      const m = modal(`<h2>Mark settlement #${s.id} as settled</h2>
        <p class="small muted">${esc(s.business_name)} · net ${inr(s.net_paise)} ${s.net_paise < 0 ? '(the business pays the loyalty fund)' : '(the loyalty fund pays the business)'}</p>
        <div class="field"><label>Amount settled (₹)</label><input id="pa" inputmode="decimal" value="${Math.abs(s.net_paise) / 100}" /></div>
        <div class="field"><label>Payment / journal reference (required)</label><input id="pr" placeholder="e.g. NEFT UTR, UPI ref, journal no." /></div>
        <div class="field"><label>Note</label><input id="pn" /></div>
        <div class="row"><button class="btn-primary" id="pgo">Mark settled</button><button data-close>Cancel</button></div>`);
      const g = $('#pgo', m.el);
      g.onclick = busy(g, async () => {
        await api.post(`/admin/settlements/${s.id}/settle`, { amount: $('#pa', m.el).value, reference: $('#pr', m.el).value, note: $('#pn', m.el).value });
        toast('Settlement marked as settled');
        m.close();
        reload();
      });
    }));
    $$('[data-void]', el).forEach((b) => (b.onclick = busy(b, async () => {
      const reason = prompt('Reason for voiding this settlement (its lines become unsettled again):');
      if (!reason) return;
      await api.post(`/admin/settlements/${b.dataset.void}/void`, { reason });
      toast('Settlement voided');
      reload();
    })));
  },

  async dashboard(el) {
    const d = await api.get('/admin/dashboard');
    const c = d.customers;
    const s = d.sales_30d;
    const max = Math.max(1, ...d.daily.map((x) => x.member + x.non_member));
    el.innerHTML = `
      ${head('Dashboard', `<span class="small muted">Last upload: ${d.last_import ? `${esc(d.last_import.filename)} · ${dt(d.last_import.uploaded_at)}` : 'none yet'}</span>`)}
      ${!d.last_import ? '<div class="alert info" style="margin-bottom:12px">No POS data yet. Go to <a href="#/upload">Excel upload</a> to import the first day\'s bills.</div>' : ''}
      <div class="grid k4">
        ${kpi('Total customers', num(c.total), `${num(c.app_users)} using the app · ${num(c.new_30d)} new in 30 days`)}
        ${kpi('Active customers', num(c.active), `Dormant ${num(c.dormant)} · Lost ${num(c.lost)}`)}
        ${kpi('Sales (30 days)', inr(s.sales), `${num(s.bills)} bills`)}
        ${kpi('Member sales share', pct(s.sales ? s.member_sales / s.sales : 0), `${inr(s.member_sales)} from members`)}
        ${kpi('Outstanding points', pts(d.liability.outstanding_cp), `${num(d.liability.holders)} customers`)}
        ${kpi('Loyalty liability', inr(d.liability.liability_paise), `at ₹${d.liability.point_value_rupees} per point`)}
        ${kpi('Redemptions today', num(d.redemptions.today_count), `${inr(d.redemptions.today_value)} · 30 days: ${inr(d.redemptions.value_30d)}`)}
        ${kpi('Reconciliation', `${num(d.open_recon_issues)} issues`, `${num(d.pending_reconciliation)} redemptions pending`)}
      </div>
      <div class="card" style="margin-top:16px">
        <div class="row between"><h2 style="margin:0">Sales — last 30 days</h2>
          <div class="legend"><span><i style="background:var(--brand)"></i>Member</span><span><i style="background:#b9d8c6"></i>Non-member</span></div></div>
        ${d.daily.length ? `<div class="bars">${d.daily.map((x) => `<div class="bar" title="${dateOnly(x.d)}: member ${inr(x.member)}, non-member ${inr(x.non_member)}">
          <div class="seg-a" style="height:${(x.member / max) * 130}px"></div><div class="seg-b" style="height:${(x.non_member / max) * 130}px"></div></div>`).join('')}</div>
          <div class="row between tiny muted"><span>${dateOnly(d.daily[0].d)}</span><span>${dateOnly(d.daily.at(-1).d)}</span></div>` : '<div class="empty">No sales in the last 30 days.</div>'}
      </div>`;
  },

  async liability(el) {
    const l = await api.get('/admin/liability');
    el.innerHTML = `
      ${head('Loyalty liability')}
      <div class="grid k4">
        ${kpi('Outstanding points', pts(l.outstanding_cp), `${num(l.holders)} customers hold points`)}
        ${kpi('Potential redemption liability', inr(l.liability_paise), `${pts(l.outstanding_cp)} × ₹${l.point_value_rupees}`)}
        ${kpi('Issued this month', pts(l.this_month?.issued_cp || 0))}
        ${kpi('Redeemed this month', pts(l.this_month?.redeemed_cp || 0))}
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:16px">
        <div><h2>Monthly points flow</h2><div class="table-wrap"><table>
          <tr><th>Month</th><th class="num">Issued</th><th class="num">Redeemed</th><th class="num">Returns reversed</th><th class="num">Adjusted</th><th class="num">Net</th></tr>
          ${l.monthly.map((m) => `<tr><td>${esc(m.month)}</td><td class="num">${pts(m.issued_cp)}</td><td class="num">${pts(m.redeemed_cp)}</td><td class="num">${pts(m.reversed_cp)}</td><td class="num">${pts(m.adjusted_cp)}</td>
            <td class="num"><b>${pts(m.issued_cp - m.redeemed_cp - m.reversed_cp + m.adjusted_cp)}</b></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No activity</td></tr>'}
        </table></div></div>
        <div><h2>Balances by size</h2><div class="table-wrap"><table>
          <tr><th>Points held</th><th class="num">Customers</th><th class="num">Points</th><th class="num">Liability</th></tr>
          ${l.bands.map((b) => `<tr><td>${esc(b.band)}</td><td class="num">${num(b.customers)}</td><td class="num">${pts(b.cp)}</td><td class="num">${inr(b.cp * l.point_value_rupees)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No outstanding points</td></tr>'}
        </table></div></div>
      </div>`;
  },

  async customers(el, _arg, pg = 1) {
    const q = $('#cq')?.value ?? '';
    const seg = $('#cseg')?.value ?? new URLSearchParams(location.hash.split('?')[1] || '').get('segment') ?? '';
    const [data, segs] = await Promise.all([api.get(`/admin/customers?${qs({ q, segment: seg, page: pg })}`), api.get('/admin/segments')]);
    segLabels = segs.labels;
    el.innerHTML = `
      ${head('Customer database')}
      <div class="filters"><input id="cq" placeholder="Search mobile, name, member ID" value="${esc(q)}" style="min-width:260px" />
        <select id="cseg"><option value="">All segments</option>${segs.counts.map((s) => `<option value="${esc(s.segment)}" ${s.segment === seg ? 'selected' : ''}>${esc(s.label)} (${s.n})</option>`).join('')}</select>
        <button class="btn-primary" id="cgo">Search</button></div>
      <div class="table-wrap"><table>
        <tr><th>Customer</th><th>Mobile</th><th class="num">Points</th><th>Last purchase</th><th>Segments</th><th>Source</th></tr>
        ${data.rows.map((c) => `<tr class="click" data-c="${c.id}">
          <td><b>${esc(c.name || '—')}</b><div class="tiny muted">${esc(c.code)}${c.status === 'BLOCKED' ? ' · <span class="badge red">BLOCKED</span>' : ''}</div></td>
          <td>${esc(c.mobile)}</td><td class="num">${pts(c.balance_cp)}</td><td>${c.last_purchase_date ? dateOnly(c.last_purchase_date) : '<span class="muted">—</span>'}</td>
          <td>${(c.segments || '').split(',').filter(Boolean).filter((s) => s !== 'APP_USER').slice(0, 4).map((s) => `<span class="badge">${esc(segName(s))}</span>`).join(' ')}</td>
          <td class="small">${esc(c.enrolled_via)}${c.app_registered_at ? ' · <span class="badge green">App</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No customers found</td></tr>'}
      </table></div>`;
    pager(el, data, (p) => VIEWS.customers(el, null, p));
    $('#cgo').onclick = () => VIEWS.customers(el);
    $('#cq').addEventListener('keydown', (e) => e.key === 'Enter' && VIEWS.customers(el));
    $('#cseg').onchange = () => VIEWS.customers(el);
    $$('[data-c]', el).forEach((tr) => (tr.onclick = () => { location.hash = `#/customer/${tr.dataset.c}`; }));
  },

  async customer(el, id) {
    const d = await api.get(`/admin/customers/${id}`);
    const c = d.customer;
    const i = d.insights;
    const trend = (t) => (t === 'up' ? '<span class="badge green">▲ up</span>' : t === 'down' ? '<span class="badge red">▼ down</span>' : '<span class="badge">flat</span>');
    el.innerHTML = `
      ${head(`${esc(c.name || 'Customer')} <span class="muted small">${esc(c.code)}</span>`, '<a class="btn btn-sm" href="#/customers">‹ Back</a>')}
      <div class="grid k4">
        ${kpi('Points balance', esc(c.balance), inr(c.reward_value_paise))}
        ${kpi('Earned / redeemed', `${esc(c.earned)} / ${esc(c.redeemed)}`, `Reversed ${esc(c.reversed)}`)}
        ${kpi('Lifetime value', inr(i.lifetime_value_paise), `${num(i.visits)} visits · avg bill ${inr(i.avg_bill_paise)}`)}
        ${kpi('Total savings', inr(d.savings.total_paise), `Points ${inr(d.savings.points_paise)} · Offers ${inr(d.savings.offers_paise)} · Coupons ${inr(d.savings.coupons_paise)}`)}
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:14px">
        <div class="card"><h3>Profile</h3>
          <div class="inline-fields">
            <div class="field"><label>Name</label><input id="pn" value="${esc(c.name || '')}" /></div>
            <div class="field"><label>Mobile</label><input id="pm" value="${esc(c.mobile)}" /></div>
            <div class="field"><label>Date of birth</label><input id="pd" type="date" value="${esc(c.dob || '')}" /></div>
            <div class="field"><label>Wedding anniversary</label><input id="pa" type="date" value="${esc(c.anniversary || '')}" /></div>
            <div class="field"><label>Status</label><select id="ps"><option ${c.status === 'ACTIVE' ? 'selected' : ''}>ACTIVE</option><option ${c.status === 'BLOCKED' ? 'selected' : ''}>BLOCKED</option></select></div>
          </div>
          <dl class="kv small"><dt>Enrolled</dt><dd>${esc(c.enrolled_via)} · ${dt(c.enrolled_at)}${c.home_branch ? ` · ${esc(c.home_branch)}` : ''}</dd>
            <dt>App</dt><dd>${c.app_registered_at ? `Registered ${dt(c.app_registered_at)}` : 'Not installed'}</dd>
            ${c.pos_customer_code ? `<dt>POS code</dt><dd>${esc(c.pos_customer_code)}</dd>` : ''}</dl>
          <button class="btn-primary btn-sm" id="psave" style="margin-top:8px">Save profile</button>
        </div>
        <div class="card"><h3>Behaviour</h3>
          <dl class="kv small">
            <dt>Last purchase</dt><dd>${i.last_purchase_date ? `${dateOnly(i.last_purchase_date)} (${i.days_since_last} days ago)` : '—'}</dd>
            <dt>First purchase</dt><dd>${i.first_purchase_date ? dateOnly(i.first_purchase_date) : '—'}</dd>
            <dt>Last 90 days</dt><dd>${i.visits_90d} visits · ${inr(i.spend_90d_paise)}</dd>
            <dt>Previous 90 days</dt><dd>${i.visits_prev_90d} visits · ${inr(i.spend_prev_90d_paise)}</dd>
            <dt>Frequency trend</dt><dd>${trend(i.frequency_trend)}</dd><dt>Spend trend</dt><dd>${trend(i.spend_trend)}</dd>
            <dt>Top categories</dt><dd>${i.categories.map((x) => `${esc(x.category)} (${inr(x.spend)})`).join(', ') || '—'}</dd>
            <dt>Branches</dt><dd>${i.branches.map((x) => `${esc(x.name)} (${x.visits})`).join(', ') || '—'}</dd>
            <dt>Segments</dt><dd>${d.segments.map((s) => `<span class="badge">${esc(s.label)}</span>`).join(' ') || '—'}</dd>
          </dl>
        </div>
        <div class="card"><h3>Manual point adjustment</h3>
          <p class="small muted">Positive to add, negative to deduct (e.g. <code>10</code> or <code>-5.50</code>). Every adjustment is logged with your name.</p>
          <div class="field"><label>Points</label><input id="ap" inputmode="decimal" /></div>
          <div class="field"><label>Reason (required)</label><input id="ar" placeholder="e.g. Goodwill for billing error on 12 Sep" /></div>
          <button class="btn-gold btn-sm" id="ago">Apply adjustment</button>
        </div>
      </div>
      <div class="tabs2">${['Ledger', 'Purchases', 'Redemptions', 'Offers'].map((t, k) => `<button data-tab="${k}" class="${k === 0 ? 'active' : ''}">${t}</button>`).join('')}</div>
      <div id="ctab"></div>`;
    const tabs = [
      () => `<div class="table-wrap"><table><tr><th>Date</th><th>Type</th><th>Details</th><th>Branch</th><th class="num">Points</th><th class="num">Balance</th></tr>
        ${d.ledger.map((l) => `<tr><td>${l.bill_date ? dateOnly(l.bill_date) : dt(l.created_at)}</td><td>${esc(LEDGER_LABEL[l.type] || l.type)}</td><td class="small">${esc(l.note || '')}${l.redemption_id ? ` · ${esc(l.redemption_id)}` : ''}</td><td>${esc(l.branch || '')}</td>
          <td class="num ${l.cp >= 0 ? 'pos' : 'neg'}">${l.cp >= 0 ? '+' : ''}${pts(l.cp)}</td><td class="num">${pts(l.balance_after_cp)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No entries</td></tr>'}</table></div>`,
      () => `<div class="table-wrap"><table><tr><th>Date</th><th>Bill</th><th>Branch</th><th>Type</th><th class="num">Bill value</th><th class="num">Discount</th><th class="num">Net</th><th class="num">Points</th><th>Loyalty ref</th></tr>
        ${d.purchases.map((p) => `<tr class="click" data-bill="${p.id}"><td>${dateOnly(p.bill_date)} ${esc(p.bill_time || '')}</td><td>${esc(p.bill_no)}</td><td>${esc(p.branch)}</td><td>${esc(p.bill_type)}</td>
          <td class="num">${inr(p.bill_value_paise)}</td><td class="num">${inr(p.discount_paise)}</td><td class="num">${inr(p.net_paise)}</td>
          <td class="num">${p.bill_type === 'SALE' ? pts(p.credited_cp) : ''}${p.reversed_cp ? ` <span class="neg">-${pts(p.reversed_cp)}</span>` : ''}</td><td class="small">${esc(p.loyalty_ref || '')}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No purchases</td></tr>'}</table></div>`,
      () => redemptionsTable(d.redemptions),
      () => `<div class="grid" style="grid-template-columns:1fr 1fr">${[['Offers for this customer', d.offers.forYou], ['Global offers', d.offers.everyone]].map(([t, list]) => `<div><h3>${t}</h3>
        ${list.map((o) => `<div class="card flat" style="margin-bottom:8px"><b>${esc(o.title)}</b> <span class="badge">${esc(o.type_label)}</span><div class="small muted">${esc(o.conditions)} · till ${dateOnly(o.valid_to)} · uses left ${o.uses_left}</div></div>`).join('') || '<p class="muted small">None</p>'}</div>`).join('')}</div>`,
    ];
    const showTab = (k) => {
      $('#ctab').innerHTML = tabs[k]();
      $$('.tabs2 button').forEach((b) => b.classList.toggle('active', Number(b.dataset.tab) === k));
      bindRedemptionRows($('#ctab'), () => VIEWS.customer(el, id));
      $$('[data-bill]', $('#ctab')).forEach((tr) => (tr.onclick = () => billModal(tr.dataset.bill)));
    };
    $$('.tabs2 button').forEach((b) => (b.onclick = () => showTab(Number(b.dataset.tab))));
    showTab(0);
    const ps = $('#psave');
    ps.onclick = busy(ps, async () => {
      await api.put(`/admin/customers/${id}`, { name: $('#pn').value, mobile: $('#pm').value, dob: $('#pd').value, anniversary: $('#pa').value, status: $('#ps').value });
      toast('Profile saved');
      VIEWS.customer(el, id);
    });
    const ag = $('#ago');
    ag.onclick = busy(ag, async () => {
      if (!confirm(`Adjust ${$('#ap').value} points?`)) return;
      await api.post(`/admin/customers/${id}/adjust`, { points: $('#ap').value, reason: $('#ar').value });
      toast('Adjustment applied');
      VIEWS.customer(el, id);
    });
  },

  async segments(el) {
    const [s, settings] = await Promise.all([api.get('/admin/segments'), api.get('/admin/settings')]);
    segLabels = s.labels;
    const seg = Object.entries(settings).filter(([k]) => k.startsWith('seg_'));
    const LBL = {
      seg_new_days: 'New: first purchase within (days)', seg_active_days: 'Active: purchased within (days)', seg_dormant_days: 'Dormant up to (days) — beyond is Lost',
      seg_regular_min_visits_90d: 'Regular: min. visits in 90 days', seg_high_value_spend_90d: 'High-value: spend in 90 days (₹)', seg_decline_ratio: 'Decline: current ÷ previous 90 days below',
      seg_weekend_share: 'Weekend shopper: share of weekend visits ≥', seg_category_share: 'Category buyer: top category share ≥',
      seg_overdue_factor: 'Overdue: days since last visit ≥ usual gap × (min 14 days)',
    };
    el.innerHTML = `
      ${head('Customer segmentation', '<button class="btn-primary" id="recalc">Recalculate now</button>')}
      <p class="small muted">Segments are recalculated automatically after every Excel upload and nightly. ${s.computed_at ? `Last run ${dt(new Date(s.computed_at).toISOString())}.` : ''}</p>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">
        <div class="table-wrap"><table><tr><th>Segment</th><th class="num">Customers</th><th></th></tr>
          ${s.counts.map((c) => `<tr><td>${esc(c.label)}</td><td class="num">${num(c.n)}</td><td class="right"><a class="btn btn-sm" href="#/customers?segment=${encodeURIComponent(c.segment)}">View</a>
            <a class="btn btn-sm" href="#/campaigns" data-camp="${esc(c.segment)}">Campaign</a></td></tr>`).join('') || '<tr><td colspan="3" class="empty">No segments yet — upload POS data first.</td></tr>'}
        </table></div>
        <div class="card"><h3>Thresholds</h3>
          ${seg.map(([k, v]) => `<div class="field"><label>${esc(LBL[k] || k)}</label><input data-k="${k}" value="${v}" inputmode="decimal" /></div>`).join('')}
          <button class="btn-primary" id="tsave">Save &amp; recalculate</button>
        </div>
      </div>`;
    const rc = $('#recalc');
    rc.onclick = busy(rc, async () => { await api.post('/admin/segments/recompute'); toast('Segments recalculated'); VIEWS.segments(el); });
    const ts = $('#tsave');
    ts.onclick = busy(ts, async () => {
      await api.put('/admin/settings', Object.fromEntries($$('[data-k]', el).map((i) => [i.dataset.k, i.value])));
      await api.post('/admin/segments/recompute');
      toast('Saved');
      VIEWS.segments(el);
    });
    $$('[data-camp]', el).forEach((a) => (a.onclick = (e) => { e.preventDefault(); campaignForm(a.dataset.camp); }));
  },

  async ledger(el, _a, pg = 1) {
    const f = { type: $('#lt')?.value ?? '', branch: $('#lb')?.value ?? '', from: $('#lf')?.value ?? '', to: $('#lto')?.value ?? '', q: $('#lq')?.value ?? '', page: pg };
    const d = await api.get(`/admin/ledger?${qs(f)}`);
    el.innerHTML = `
      ${head('Points ledger')}
      <div class="filters">
        <select id="lt"><option value="">All types</option>${Object.entries(LEDGER_LABEL).map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <select id="lb">${branchOptions(f.branch)}</select>
        <input type="date" id="lf" value="${f.from}" /><input type="date" id="lto" value="${f.to}" />
        <input id="lq" placeholder="Mobile / member ID" value="${esc(f.q)}" />
        <button class="btn-primary" id="lgo">Filter</button>
      </div>
      <div class="grid k4" style="margin-bottom:12px">${kpi('Credits', pts(d.credit_cp))}${kpi('Debits', pts(d.debit_cp))}${kpi('Net', pts(d.credit_cp + d.debit_cp))}</div>
      <div class="table-wrap"><table><tr><th>Date</th><th>Customer</th><th>Type</th><th>Details</th><th>Branch</th><th class="num">Points</th><th class="num">Balance after</th></tr>
        ${d.rows.map((l) => `<tr><td>${dt(l.created_at)}${l.bill_date ? `<div class="tiny muted">Bill ${dateOnly(l.bill_date)}</div>` : ''}</td><td><a href="#/customer/${l.customer_id}">${esc(l.mobile)}</a><div class="tiny muted">${esc(l.customer_name || '')}</div></td><td>${esc(LEDGER_LABEL[l.type] || l.type)}</td>
          <td class="small">${esc(l.note || '')}${l.redemption_id ? ` · ${esc(l.redemption_id)}` : ''}</td><td>${esc(l.branch || '')}</td>
          <td class="num ${l.cp >= 0 ? 'pos' : 'neg'}">${l.cp >= 0 ? '+' : ''}${pts(l.cp)}</td><td class="num">${pts(l.balance_after_cp)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No entries</td></tr>'}
      </table></div>`;
    pager(el, d, (p) => VIEWS.ledger(el, null, p));
    $('#lgo').onclick = () => VIEWS.ledger(el);
  },

  async upload(el) {
    el.innerHTML = `
      ${head('Daily Excel upload', '<button id="tpl">Download template</button>')}
      <div class="card stack">
        <div class="field"><label>How should points be calculated for this file?</label>
          <div class="mode-pick">
            <label><input type="radio" name="umode" value="AMOUNT" checked /><span><b>From bill amount</b><br/><span class="small muted">₹200 net eligible value = 1 point, plus automatic bonus / multiplier offers.</span></span></label>
            <label><input type="radio" name="umode" value="POINTS" /><span><b>Points given in file</b><br/><span class="small muted">The file has a <b>Points</b> column from the POS. Credited exactly as given; no automatic offers added.</span></span></label>
          </div></div>
        <div class="inline-fields">
          <div class="field"><label>Branch for this file</label><select id="ub">${branchOptions('', 'Use the Branch column in the file')}</select></div>
        </div>
        <div class="drop" id="drop"><p><b>Drop the POS Excel / CSV file here</b></p><p class="small muted">or</p>
          <input type="file" id="file" accept=".xlsx,.xls,.csv" style="width:auto" /></div>
        <details class="small"><summary>Required and optional columns</summary><div id="cols" class="small" style="margin-top:8px"></div></details>
      </div>
      <div id="ures" style="margin-top:16px"></div>`;
    const mode = () => $('[name="umode"]:checked', el)?.value || 'AMOUNT';
    $('#tpl').onclick = async () => {
      const blob = await api.call('GET', `/admin/imports/template?mode=${mode()}`, undefined, { blob: true });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `vasantham-pos-upload-${mode() === 'POINTS' ? 'points' : 'amount'}-template.xlsx`;
      a.click();
    };
    const columnsHelp = (c) => {
      $('#cols').innerHTML = mode() === 'POINTS'
        ? `<p><b>Required:</b> Bill No, Bill Date, Branch (or choose above), <b>Points</b> (per bill, up to 2 decimals), and Customer Mobile and/or Customer Code for member bills.<br/>
        <b>Recommended:</b> Net Eligible Value (for purchase history and analytics), Bill Time, Loyalty Ref, Loyalty Discount, Bill Type (SALE / RETURN / CANCELLED), Original Bill No.<br/>
        <b>Returns:</b> the Points on a RETURN row are the points to take back (never more than the original bill earned). CANCELLED bills take back all remaining points of the original bill.<br/>
        If the file has one row per item, put the bill's total points on each row (or on the first row only).</p>
        <p class="muted">Dates are read as DD-MM-YYYY. Accepted header spellings: ${Object.entries(c.accepted).map(([k, v]) => `<code>${esc(k)}</code>: ${esc(v.join(', '))}`).join('; ')}</p>`
        : `<p><b>Required:</b> Bill No, Bill Date, Branch (or choose above), Net Eligible Value, and Customer Mobile and/or Customer Code for member bills.<br/>
        <b>Recommended:</b> Bill Time, Bill Value, Discount, Loyalty Ref (Redemption ID, e.g. VR-260923-1048), Loyalty Discount, Bill Type (SALE / RETURN / CANCELLED), Original Bill No.<br/>
        <b>Item-level (optional):</b> Product Code, Product, Category, Qty, Rate, Item Discount, Item Amount — one row per item, bill fields repeated.</p>
        <p class="muted">Dates are read as DD-MM-YYYY. Accepted header spellings: ${Object.entries(c.accepted).map(([k, v]) => `<code>${esc(k)}</code>: ${esc(v.join(', '))}`).join('; ')}</p>`;
    };
    api.get('/admin/imports/columns').then((c) => {
      columnsHelp(c);
      $$('[name="umode"]', el).forEach((r) => (r.onchange = () => columnsHelp(c)));
    });
    const drop = $('#drop');
    const doUpload = async (file, force = false) => {
      if (!file) return;
      $('#ures').innerHTML = '<div class="spinner"></div><p class="center muted">Processing… large files can take a minute.</p>';
      try {
        const buf = await file.arrayBuffer();
        const r = await api.call('POST', `/admin/imports?${qs({ filename: file.name, branch: $('#ub').value, mode: mode(), force: force ? 1 : '' })}`, undefined, { raw: buf });
        $('#ures').innerHTML = importResult(r);
        toast('Upload processed');
      } catch (e) {
        $('#ures').innerHTML = `<div class="alert error">${esc(e.message)}</div>${/already imported/.test(e.message) ? '<button id="force" style="margin-top:8px">Process again anyway (duplicate bills will still be skipped)</button>' : ''}`;
        $('#force')?.addEventListener('click', () => doUpload(file, true));
      }
    };
    $('#file').onchange = (e) => doUpload(e.target.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); doUpload(e.dataTransfer.files[0]); };
  },

  async imports(el) {
    const rows = await api.get('/admin/imports');
    el.innerHTML = `
      ${head('Upload history', '<a class="btn btn-primary" href="#/upload">New upload</a>')}
      <div class="table-wrap"><table><tr><th>#</th><th>File</th><th>Uploaded</th><th>Status</th><th>Points by</th><th>Bill dates</th><th class="num">Bills</th><th class="num">Duplicates</th><th class="num">Errors</th><th class="num">New customers</th><th class="num">Points credited</th><th class="num">Reconciled</th><th class="num">Issues</th></tr>
        ${rows.map((i) => `<tr class="click" data-i="${i.id}"><td>${i.id}</td><td>${esc(i.filename)}</td><td>${dt(i.uploaded_at)}<div class="tiny muted">${esc(i.uploaded_by_name || '')}</div></td>
          <td><span class="badge ${i.status === 'COMPLETED' ? 'green' : i.status === 'FAILED' ? 'red' : 'warn'}">${esc(i.status.replace(/_/g, ' '))}</span></td>
          <td class="small">${i.calc_mode === 'POINTS' ? 'Points column' : 'Amount'}</td>
          <td class="small">${i.min_bill_date ? `${dateOnly(i.min_bill_date)}${i.max_bill_date !== i.min_bill_date ? ` – ${dateOnly(i.max_bill_date)}` : ''}` : ''}</td>
          <td class="num">${num(i.bills_imported)}/${num(i.bills_total)}</td><td class="num">${num(i.bills_duplicate)}</td><td class="num">${num(i.bills_error)}</td><td class="num">${num(i.new_customers)}</td>
          <td class="num">${pts(i.points_credited_cp)}</td><td class="num">${num(i.redemptions_reconciled)}</td><td class="num">${num(i.recon_issues)}</td></tr>`).join('') || '<tr><td colspan="13" class="empty">No uploads yet</td></tr>'}
      </table></div>`;
    $$('[data-i]', el).forEach((tr) => (tr.onclick = async () => {
      const d = await api.get(`/admin/imports/${tr.dataset.i}`);
      modal(`<div class="row between"><h2>Upload #${d.id} — ${esc(d.filename)}</h2><button data-close class="btn-sm">Close</button></div>
        ${importResult({ ...d, imported: d.bills_imported, duplicate: d.bills_duplicate, error: d.bills_error, items: d.items_imported, newCustomers: d.new_customers, creditedCp: d.points_credited_cp, reversedCp: d.points_reversed_cp, reconciled: d.redemptions_reconciled, issues: d.recon_issues, errors: d.errors })}`, { wide: true });
    }));
  },

  async offers(el) {
    const [rows, types] = await Promise.all([api.get('/admin/offers'), api.get('/admin/offers/types')]);
    offerTypes = types;
    const today = todayIST();
    el.innerHTML = `
      ${head('Offers', '<button class="btn-primary" id="newo">New offer</button>')}
      <div class="table-wrap"><table><tr><th>Offer</th><th>Type</th><th>Audience</th><th>Validity</th><th class="num">Value</th><th class="num">Assigned</th><th class="num">Used</th><th>Status</th><th></th></tr>
        ${rows.map((o) => {
          const live = o.active && o.valid_from <= today && o.valid_to >= today;
          return `<tr><td><b>${esc(o.title)}</b> <span class="badge ${o.business_id === ownerBiz()?.id ? '' : 'blue'}">${esc(o.business_name || '')}</span>${o.points_cost_cp ? ` <span class="badge gold">${pts(o.points_cost_cp)} pts</span>` : ''}${o.target_segments ? ` <span class="badge warn" title="${esc(o.target_segments)}">Targeted</span>` : ''}${o.funding_type && o.funding_type !== 'PROGRAM' ? ` <span class="badge">${o.funding_type === 'PARTNER' ? 'Partner-funded' : 'Shared'}${o.funder_name ? `: ${esc(o.funder_name)}` : ''}</span>` : ''}${o.attachment ? ` <span class="small">${attachmentLink({ ...o.attachment, name: o.attachment.kind === 'pdf' ? 'PDF' : 'Image' })}</span>` : ''}<div class="tiny muted">${esc(o.conditions)}${o.coupon_code ? ` · Coupon ${esc(o.coupon_code)}` : ''}${o.campaign_name ? ` · Campaign: ${esc(o.campaign_name)}` : ''}</div></td>
          <td class="small">${esc(o.type_label)}</td><td>${o.audience === 'GLOBAL' ? '<span class="badge blue">Everyone</span>' : '<span class="badge gold">Personalised</span>'}</td>
          <td class="small">${dateOnly(o.valid_from)} – ${dateOnly(o.valid_to)}</td><td class="num">${o.value_paise ? inr(o.value_paise) : o.bonus_cp ? `${pts(o.bonus_cp)} pts` : o.multiplier ? `${o.multiplier}×` : ''}</td>
          <td class="num">${o.audience === 'PERSONAL' ? num(o.assigned) : '—'}</td><td class="num">${num(o.redeemed + o.auto_applied)}</td>
          <td>${live ? '<span class="badge green">Live</span>' : o.active ? (o.valid_to < today ? '<span class="badge">Expired</span>' : '<span class="badge blue">Scheduled</span>') : '<span class="badge">Inactive</span>'}</td>
          <td class="right" style="white-space:nowrap"><button class="btn-sm" data-edit="${o.id}">Edit</button>
            ${o.audience === 'PERSONAL' ? `<button class="btn-sm" data-assign="${o.id}">Assign</button>` : ''}
            ${o.audience === 'GLOBAL' && o.active && o.valid_to >= today ? `<button class="btn-sm" data-notify="${o.id}" title="Send this offer to every customer who uses the app">Send to app</button>` : ''}
            <button class="btn-sm" data-toggle="${o.id}" data-active="${o.active}">${o.active ? 'Deactivate' : 'Activate'}</button></td></tr>`;
        }).join('') || '<tr><td colspan="9" class="empty">No offers yet</td></tr>'}
      </table></div>`;
    $('#newo').onclick = () => offerForm(null, () => VIEWS.offers(el));
    $$('[data-edit]', el).forEach((b) => (b.onclick = () => offerForm(rows.find((o) => o.id === Number(b.dataset.edit)), () => VIEWS.offers(el))));
    $$('[data-toggle]', el).forEach((b) => (b.onclick = busy(b, async () => { await api.put(`/admin/offers/${b.dataset.toggle}`, { active: b.dataset.active !== '1' }); VIEWS.offers(el); })));
    $$('[data-assign]', el).forEach((b) => (b.onclick = () => assignForm(rows.find((o) => o.id === Number(b.dataset.assign)), () => VIEWS.offers(el))));
    $$('[data-notify]', el).forEach((b) => (b.onclick = busy(b, async () => {
      const o = rows.find((x) => x.id === Number(b.dataset.notify));
      if (!confirm(`Send "${o.title}" as a notification to all customers using the app?`)) return;
      const r = await api.post(`/admin/offers/${o.id}/notify`);
      toast(`Sent to ${r.sent} of ${r.app_users} app users${r.skipped ? ` (${r.skipped} already reached today's notification limit)` : ''}`);
    })));
  },

  async campaigns(el) {
    const rows = await api.get('/admin/campaigns');
    el.innerHTML = `
      ${head('Campaigns', '<button class="btn-primary" id="newc">New campaign</button>')}
      <p class="small muted">A campaign targets a customer segment with a personalised offer for a limited period, then measures who came back, who redeemed, revenue and cost.</p>
      <div class="table-wrap"><table><tr><th>Campaign</th><th>Segment</th><th>Offer</th><th>Period</th><th class="num">Audience</th><th>Created</th></tr>
        ${rows.map((c) => `<tr class="click" data-camp="${c.id}"><td><b>${esc(c.name)}</b></td><td>${esc(c.segment_label)}</td><td class="small">${esc(c.offer_title || '')}</td>
          <td class="small">${dateOnly(c.start_date)} – ${dateOnly(c.end_date)}</td><td class="num">${num(c.audience_size)}</td><td class="small">${dt(c.created_at)}<div class="tiny muted">${esc(c.created_by_name || '')}</div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No campaigns yet</td></tr>'}
      </table></div>`;
    $('#newc').onclick = () => campaignForm();
    $$('[data-camp]', el).forEach((tr) => (tr.onclick = () => { location.hash = `#/campaign/${tr.dataset.camp}`; }));
  },

  async campaign(el, id) {
    const r = await api.get(`/admin/campaigns/${id}`);
    const c = r.campaign;
    el.innerHTML = `
      ${head(`${esc(c.name)}`, '<a class="btn btn-sm" href="#/campaigns">‹ Back</a>')}
      <p class="muted">${esc(segName(c.segment))} · ${esc(r.offer?.title || '')} (${esc(offerTypes[r.offer?.type]?.label || r.offer?.type || '')}) · ${dateOnly(c.start_date)} – ${dateOnly(c.end_date)}</p>
      <div class="grid k4">
        ${kpi('Audience', num(r.audience_size), 'customers who received the offer')}
        ${kpi('Returned', num(r.returned_customers), `Return rate ${pct(r.return_rate)}`)}
        ${kpi('Redeemed', num(r.redeemed_customers), `Redemption rate ${pct(r.redemption_rate)}`)}
        ${kpi('Revenue (audience)', inr(r.revenue_paise), `${num(r.bills)} bills · avg ${inr(r.avg_bill_paise)}`)}
        ${kpi('Revenue from redeemers', inr(r.redeemer_revenue_paise))}
        ${kpi('Discount cost', inr(r.discount_cost_paise))}
        ${kpi('Revenue ÷ cost', r.roi ? `${r.roi.toFixed(1)}×` : '—', 'redeemer revenue per ₹1 of discount')}
      </div>
      <h2 style="margin-top:16px">By branch</h2>
      <div class="table-wrap"><table><tr><th>Branch</th><th class="num">Returning customers</th><th class="num">Revenue</th></tr>
        ${r.branches.map((b) => `<tr><td>${esc(b.name)}</td><td class="num">${num(b.customers)}</td><td class="num">${inr(b.revenue)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No purchases from the audience yet</td></tr>'}</table></div>
      <p class="tiny muted" style="margin-top:8px">Returned = audience members with at least one bill during the campaign period. Revenue figures depend on the daily Excel uploads.</p>`;
  },

  async redemptions(el, _a, pg = 1) {
    const f = { status: $('#rs')?.value ?? '', business: $('#rz')?.value ?? '', branch: $('#rb')?.value ?? '', from: $('#rf')?.value ?? '', to: $('#rt')?.value ?? '', q: $('#rq')?.value ?? '', page: pg };
    const d = await api.get(`/admin/redemptions?${qs(f)}`);
    const ST = ['CREATED', 'APPROVED', 'SUBMITTED', 'BILLED', 'RECONCILED', 'REVERSED', 'CANCELLED', 'EXPIRED'];
    const sc = Object.fromEntries(d.statusCounts.map((s) => [s.status, s]));
    el.innerHTML = `
      ${head('Redemption monitor')}
      <div class="row" style="margin-bottom:12px">${ST.map((s) => `<span class="small">${statusBadge(s)} ${num(sc[s]?.n || 0)}</span>`).join('')}</div>
      <div class="filters">
        <select id="rs"><option value="">All statuses</option>${ST.map((s) => `<option ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="rz">${bizOptions(f.business)}</select><select id="rb">${branchOptions(f.branch)}</select><input type="date" id="rf" value="${f.from}" /><input type="date" id="rt" value="${f.to}" />
        <input id="rq" placeholder="Redemption ID / mobile" value="${esc(f.q)}" /><button class="btn-primary" id="rgo">Filter</button>
      </div>
      ${redemptionsTable(d.rows)}`;
    pager(el, d, (p) => VIEWS.redemptions(el, null, p));
    $('#rgo').onclick = () => VIEWS.redemptions(el);
    bindRedemptionRows(el, () => VIEWS.redemptions(el, null, pg));
  },

  async reconciliation(el) {
    const f = { status: $('#xs')?.value ?? 'OPEN', branch: $('#xb')?.value ?? '' };
    const r = await api.get(`/admin/reconciliation?${qs(f)}`);
    el.innerHTML = `
      ${head('Redemption reconciliation')}
      <p class="small muted">Manager-approved redemptions compared with the billing data from the daily Excel upload (matched on the Redemption ID in the bill's loyalty reference / remarks and the loyalty discount amount).</p>
      <div class="grid k4" style="margin-bottom:12px">
        ${kpi('Reconciled', num(r.summary.reconciled))}${kpi('Awaiting bill', num(r.summary.pending))}${kpi('Billed, amount not matched', num(r.summary.billed_unmatched))}
        ${Object.entries(r.labels).map(([k, v]) => r.counts[k] ? kpi(esc(v), num(r.counts[k])) : '').join('')}
      </div>
      <div class="filters"><select id="xs">${['OPEN', 'RESOLVED', 'ALL'].map((s) => `<option ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="xb">${branchOptions(f.branch)}</select><button class="btn-primary" id="xgo">Filter</button></div>
      ${r.missing.length ? `<h2>Missing billing entry (${r.missing.length})</h2>
        <p class="small muted">Approved, but no bill with this Redemption ID was found even though the branch's later bills have been uploaded.</p>
        <div class="table-wrap" style="margin-bottom:16px"><table><tr><th>Redemption</th><th>Approved</th><th>Branch</th><th>Customer</th><th class="num">Value</th><th>Branch data up to</th><th></th></tr>
        ${r.missing.map((m) => `<tr><td><b>${esc(m.id)}</b></td><td>${dt(m.approved_at)}<div class="tiny muted">${esc(m.approved_by_name || '')}</div></td><td>${esc(m.branch_name)}</td>
          <td>${esc(m.mobile)}</td><td class="num">${inr(m.value_paise)}</td><td>${dateOnly(m.last_bill_date)}</td><td class="right"><button class="btn-sm" data-rid="${esc(m.id)}">Review</button></td></tr>`).join('')}</table></div>` : ''}
      <h2>Issues</h2>
      <div class="table-wrap"><table><tr><th>Type</th><th>Redemption / ref</th><th>Bill</th><th>Branch</th><th class="num">Approved</th><th class="num">Billed</th><th>Detail</th><th></th></tr>
        ${r.issues.map((i) => `<tr><td><span class="badge ${i.resolved_at ? '' : 'red'}">${esc(i.type_label)}</span></td><td>${i.redemption_id ? `<a href="#" data-rid="${esc(i.redemption_id)}">${esc(i.redemption_id)}</a>` : esc(i.ref_text || '')}</td>
          <td>${esc(i.bill_no || '')}<div class="tiny muted">${i.bill_date ? dateOnly(i.bill_date) : ''}</div></td><td>${esc(i.branch_name || '')}</td>
          <td class="num">${i.expected_paise != null ? inr(i.expected_paise) : ''}</td><td class="num">${i.actual_paise != null ? inr(i.actual_paise) : i.type === 'WRONG_AMOUNT' ? '—' : ''}</td>
          <td class="small">${esc(i.detail || '')}${i.resolved_at ? `<div class="tiny muted">Resolved ${dt(i.resolved_at)}: ${esc(i.resolution_note)}</div>` : ''}</td>
          <td class="right">${i.resolved_at ? '' : `<button class="btn-sm" data-resolve="${i.id}" data-has-red="${i.redemption_id ? 1 : 0}">Resolve</button>`}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No issues 🎉</td></tr>'}
      </table></div>`;
    $('#xgo').onclick = () => VIEWS.reconciliation(el);
    $$('[data-rid]', el).forEach((b) => (b.onclick = (e) => { e.preventDefault(); redemptionModal(b.dataset.rid, () => VIEWS.reconciliation(el)); }));
    $$('[data-resolve]', el).forEach((b) => (b.onclick = () => {
      const m = modal(`<h2>Resolve issue</h2>
        <div class="field"><label>Resolution note (required)</label><textarea id="rn" rows="3" placeholder="What was found and what was done"></textarea></div>
        ${b.dataset.hasRed === '1' ? '<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" id="mr" style="width:auto" /> Also mark the redemption as reconciled</label>' : ''}
        <div class="row" style="margin-top:12px"><button class="btn-primary" id="ok">Resolve</button><button data-close>Cancel</button></div>`);
      const ok = $('#ok', m.el);
      ok.onclick = busy(ok, async () => {
        await api.post(`/admin/reconciliation/${b.dataset.resolve}/resolve`, { note: $('#rn', m.el).value, markReconciled: $('#mr', m.el)?.checked });
        m.close();
        toast('Issue resolved');
        VIEWS.reconciliation(el);
      });
    }));
  },

  async 'cust-analytics'(el) {
    const a = await api.get('/admin/analytics/customers');
    el.innerHTML = `
      ${head('Customer analytics')}
      <div class="grid k4">
        ${kpi('Total customers', num(a.total_customers), `${num(a.buyers)} have purchased`)}
        ${kpi('Repeat customers', num(a.repeat_customers), `${pct(a.repeat_rate)} of buyers`)}
        ${kpi('Average bill value', inr(a.avg_bill_paise))}
        ${kpi('Avg lifetime value', inr(a.avg_lifetime_value_paise), 'per purchasing customer')}
        ${kpi('Visit frequency', `${a.monthly_visit_frequency.toFixed(2)} / month`, `${a.visits_per_customer_90d.toFixed(1)} visits in 90 days`)}
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));margin-top:16px">
        <div><h2>Segments</h2><div class="table-wrap"><table><tr><th>Segment</th><th class="num">Customers</th></tr>
          ${a.segments.map((s) => `<tr><td>${esc(s.label)}</td><td class="num">${num(s.n)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">—</td></tr>'}</table></div></div>
        <div><h2>Monthly member activity</h2><div class="table-wrap"><table><tr><th>Month</th><th class="num">Customers</th><th class="num">Bills</th><th class="num">Spend</th><th class="num">Spend / customer</th></tr>
          ${a.monthly.map((m) => `<tr><td>${esc(m.month)}</td><td class="num">${num(m.customers)}</td><td class="num">${num(m.bills)}</td><td class="num">${inr(m.spend)}</td><td class="num">${inr(m.spend_per_customer)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">—</td></tr>'}</table></div></div>
        <div><h2>Top customers by lifetime value</h2><div class="table-wrap"><table><tr><th>Customer</th><th class="num">Visits</th><th class="num">Lifetime</th><th>Last purchase</th></tr>
          ${a.top.map((c) => `<tr class="click" data-c="${c.id}"><td>${esc(c.name || c.mobile)}<div class="tiny muted">${esc(c.mobile)}</div></td><td class="num">${num(c.visits)}</td><td class="num">${inr(c.lifetime_paise)}</td><td>${dateOnly(c.last_purchase_date)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">—</td></tr>'}</table></div></div>
        <div><h2>Category preferences</h2><div class="table-wrap"><table><tr><th>Category</th><th class="num">Customers</th><th class="num">Spend</th></tr>
          ${a.categories.map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${num(c.customers)}</td><td class="num">${inr(c.spend)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Needs item-level Excel data</td></tr>'}</table></div></div>
      </div>`;
    $$('[data-c]', el).forEach((tr) => (tr.onclick = () => { location.hash = `#/customer/${tr.dataset.c}`; }));
  },

  async 'branch-analytics'(el) {
    const f = { from: $('#bf')?.value ?? '', to: $('#bt')?.value ?? '' };
    const d = await api.get(`/admin/analytics/branches?${qs(f)}`);
    const cols = [
      ['Bills', (r) => num(r.bills)], ['Total sales', (r) => inr(r.sales_paise)], ['Member sales', (r) => inr(r.member_sales_paise)], ['Non-member sales', (r) => inr(r.non_member_sales_paise)],
      ['Member share', (r) => pct(r.member_share)], ['Loyalty-linked sales', (r) => inr(r.loyalty_linked_sales_paise)], ['Identified customers', (r) => num(r.identified_customers)],
      ['New customers', (r) => num(r.new_customers)], ['Repeat customers', (r) => num(r.repeat_customers)], ['Points issued', (r) => pts(r.points_issued_cp)],
      ['Points redeemed', (r) => pts(r.points_redeemed_cp)], ['Offer redemptions', (r) => num(r.offer_redemptions)], ['Loyalty cost', (r) => inr(r.loyalty_cost_paise)],
      ['Loyalty cost % sales', (r) => pct(r.loyalty_cost_pct, 2)], ['Avg bill value', (r) => inr(r.avg_bill_paise)], ['Redemption rate', (r) => pct(r.redemption_rate)],
    ];
    el.innerHTML = `
      ${head('Branch analytics')}
      <div class="filters"><div><label>From</label><input type="date" id="bf" value="${d.from}" /></div><div><label>To</label><input type="date" id="bt" value="${d.to}" /></div><button class="btn-primary" id="bgo">Apply</button></div>
      <div class="table-wrap"><table><tr><th>Metric</th>${d.rows.map((r) => `<th class="num">${esc(r.name)}</th>`).join('')}</tr>
        ${cols.map(([l, fn]) => `<tr><td>${l}</td>${d.rows.map((r) => `<td class="num">${fn(r)}</td>`).join('')}</tr>`).join('')}</table></div>
      <p class="tiny muted" style="margin-top:8px">Member sales = bills tagged with a customer mobile / ID. Loyalty-linked = bills carrying a redemption reference. Redemption rate = redemptions ÷ member bills.</p>`;
    $('#bgo').onclick = () => VIEWS['branch-analytics'](el);
  },

  async branches(el) {
    const [bs, staff, roles] = await Promise.all([api.get('/admin/branches'), can('staff.manage') ? api.get('/admin/staff') : [], can('staff.manage') ? api.get('/admin/staff/roles') : {}]);
    branches = bs;
    el.innerHTML = `
      ${head(can('staff.manage') ? 'Branches & staff' : 'Branches')}
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(380px,1fr))">
        <div class="stack"><h2>Branches</h2>
          <div class="table-wrap"><table><tr><th>Code</th><th>Name</th><th>Business</th><th>City</th><th>Contact (shown in app)</th><th class="num">Managers</th><th>Last bill</th><th></th></tr>
            ${bs.map((b) => `<tr><td><b>${esc(b.code)}</b></td><td>${esc(b.name)}</td><td class="small">${esc(b.business_name || '')}</td><td>${esc(b.city || '')}</td>
              <td class="small">${b.address || b.phone || b.whatsapp ? `${esc(b.phone || '')}${b.whatsapp ? ' · WhatsApp' : ''}${b.map_url ? ' · Map' : ''}<div class="tiny muted">${esc(b.address || '')}</div>` : '<span class="muted">Not set</span>'}</td><td class="num">${b.managers}</td><td>${b.last_bill_date ? dateOnly(b.last_bill_date) : '—'}</td>
              <td class="right"><button class="btn-sm" data-eb="${b.id}">Edit</button>${b.active ? '' : ' <span class="badge">Inactive</span>'}</td></tr>`).join('')}</table></div>
          <div class="card add-branch"><h3>Add branch</h3><div class="inline-fields"><input id="bc" placeholder="Code (as in POS export)" /><input id="bn" placeholder="Name" /><input id="bci" placeholder="City" /><select id="bbz">${bizOptions(ownerBiz()?.id, '')}</select></div>
            <p class="tiny muted" style="margin:6px 0 0">Add the address, phone, WhatsApp and map link with <b>Edit</b> after creating the branch.</p>
            <button class="btn-primary btn-sm" id="badd" style="margin-top:8px">Add branch</button></div>
        </div>
        ${can('staff.manage') ? `<div class="stack"><h2>Staff logins</h2>
          <div class="table-wrap"><table><tr><th>User</th><th>Role</th><th>Branch / business</th><th>Last login</th><th></th></tr>
            ${staff.map((s) => `<tr><td><b>${esc(s.name)}</b><div class="tiny muted">${esc(s.username)}${s.active ? '' : ' · <span class="neg">disabled</span>'}</div></td>
              <td><span class="badge ${s.access_role === 'SUPER_ADMIN' ? 'gold' : s.role === 'MANAGER' ? 'green' : 'blue'}">${esc(s.access_label)}</span></td>
              <td class="small">${esc(s.branch || '')}${s.branch && s.business ? '<br/>' : ''}<span class="muted">${esc(s.business || (s.role === 'ADMIN' ? 'All businesses' : ''))}</span></td><td class="small">${s.last_login_at ? dt(s.last_login_at) : 'never'}</td>
              <td class="right" style="white-space:nowrap"><button class="btn-sm" data-se="${s.id}">Role</button> <button class="btn-sm" data-pw="${s.id}">Reset password</button> <button class="btn-sm" data-act="${s.id}" data-on="${s.active}">${s.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}</table></div>
          <div class="card"><h3>Add staff</h3>
            <div class="inline-fields"><input id="su" placeholder="Username" /><input id="sn" placeholder="Full name" />
              <select id="sr">${Object.entries(roles).map(([k, r]) => `<option value="${k}" ${k === 'BRANCH_MANAGER' ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>
              <select id="sb">${branchOptions('', 'Branch / outlet…')}</select><select id="sz">${bizOptions('', 'Business…')}</select>
              <input id="sp" type="password" placeholder="Password (min 8)" autocomplete="new-password" /></div>
            <div class="tiny muted" id="srh" style="margin-top:6px"></div>
            <button class="btn-primary btn-sm" id="sadd" style="margin-top:8px">Create login</button></div>
        </div>` : ''}
      </div>`;
    const reload = () => VIEWS.branches(el);
    const ba = $('#badd');
    ba.onclick = busy(ba, async () => { await api.post('/admin/branches', { code: $('#bc').value, name: $('#bn').value, city: $('#bci').value, business_id: $('#bbz').value }); toast('Branch added'); reload(); });
    $$('[data-eb]', el).forEach((b) => (b.onclick = () => {
      const br = bs.find((x) => x.id === Number(b.dataset.eb));
      const m = modal(`<h2>Edit ${esc(br.code)}</h2><div class="field"><label>Name</label><input id="en" value="${esc(br.name)}" /></div><div class="field"><label>City</label><input id="ec" value="${esc(br.city || '')}" /></div>
        <div class="field"><label>Business</label><select id="ebz">${bizOptions(br.business_id, '')}</select><div class="tiny muted">Can only change before the branch has bills or redemptions.</div></div>
        <h3 style="margin-top:14px">Contact details shown in the Customer App</h3>
        <div class="field"><label>Address</label><textarea id="ead" rows="3" placeholder="Door no, street, area, city – PIN">${esc(br.address || '')}</textarea></div>
        <div class="inline-fields"><div class="field"><label>Phone (tap to call)</label><input id="eph" inputmode="tel" value="${esc(br.phone || '')}" placeholder="044 2626 1234" /></div>
          <div class="field"><label>WhatsApp number</label><input id="ewa" inputmode="tel" value="${esc(br.whatsapp || '')}" placeholder="98400 00000" /></div></div>
        <div class="field"><label>Google Maps link (optional)</label><input id="emap" inputmode="url" value="${esc(br.map_url || '')}" placeholder="https://maps.app.goo.gl/…" />
          <div class="tiny muted">In Google Maps, open the store → Share → Copy link. If you leave this empty, the app searches Maps for the address.</div></div>
        <label style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" id="ea" style="width:auto" ${br.active ? 'checked' : ''} /> Active</label>
        <div class="row" style="margin-top:12px"><button class="btn-primary" id="es">Save</button><button data-close>Cancel</button></div>`);
      const es = $('#es', m.el);
      es.onclick = busy(es, async () => { await api.put(`/admin/branches/${br.id}`, {
        name: $('#en', m.el).value, city: $('#ec', m.el).value, active: $('#ea', m.el).checked, business_id: Number($('#ebz', m.el).value),
        address: $('#ead', m.el).value, phone: $('#eph', m.el).value, whatsapp: $('#ewa', m.el).value, map_url: $('#emap', m.el).value,
      }); m.close(); reload(); });
    }));
    if (!can('staff.manage')) return;
    // role → which of branch / business applies
    const syncRole = (root, roleSel, brSel, bzSel, hint) => {
      const r = roles[$(roleSel, root).value] || {};
      $(brSel, root).classList.toggle('hidden', !r.branch);
      $(bzSel, root).classList.toggle('hidden', !r.business);
      if (hint) $(hint, root).textContent = `${r.about || ''}${r.business === 'optional' ? ' Choose a business to limit this login to it, or leave empty for all businesses.' : ''}`;
    };
    $('#sr').onchange = () => syncRole(el, '#sr', '#sb', '#sz', '#srh');
    syncRole(el, '#sr', '#sb', '#sz', '#srh');
    const sa = $('#sadd');
    sa.onclick = busy(sa, async () => {
      await api.post('/admin/staff', { username: $('#su').value, name: $('#sn').value, access_role: $('#sr').value, branch_id: $('#sb').value, business_id: $('#sz').value, password: $('#sp').value });
      toast('Login created');
      reload();
    });
    $$('[data-se]', el).forEach((b) => (b.onclick = () => {
      const s = staff.find((x) => x.id === Number(b.dataset.se));
      const m = modal(`<h2>Role for ${esc(s.name)}</h2>
        <div class="field"><label>Role</label><select id="er">${Object.entries(roles).map(([k, r]) => `<option value="${k}" ${k === s.access_role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></div>
        <div class="tiny muted" id="erh" style="margin-bottom:8px"></div>
        <div class="field"><label>Branch / outlet</label><select id="eb">${branchOptions(s.branch_id, 'Branch / outlet…')}</select></div>
        <div class="field"><label>Business</label><select id="ez">${bizOptions(s.business_id || '', 'All businesses')}</select></div>
        <div class="row"><button class="btn-primary" id="esv">Save</button><button data-close>Cancel</button></div>`);
      const sync = () => syncRole(m.el, '#er', '#eb', '#ez', '#erh');
      $('#er', m.el).onchange = sync;
      sync();
      $('#eb', m.el).parentElement.classList.toggle('hidden', $('#eb', m.el).classList.contains('hidden'));
      $('#ez', m.el).parentElement.classList.toggle('hidden', $('#ez', m.el).classList.contains('hidden'));
      $('#er', m.el).addEventListener('change', () => {
        $('#eb', m.el).parentElement.classList.toggle('hidden', $('#eb', m.el).classList.contains('hidden'));
        $('#ez', m.el).parentElement.classList.toggle('hidden', $('#ez', m.el).classList.contains('hidden'));
      });
      const sv = $('#esv', m.el);
      sv.onclick = busy(sv, async () => {
        await api.put(`/admin/staff/${s.id}`, { access_role: $('#er', m.el).value, branch_id: $('#eb', m.el).value || null, business_id: $('#ez', m.el).value || null });
        toast('Role updated');
        m.close();
        reload();
      });
    }));
    $$('[data-pw]', el).forEach((b) => (b.onclick = busy(b, async () => {
      const pw = prompt('New password (min 8 characters):');
      if (!pw) return;
      await api.put(`/admin/staff/${b.dataset.pw}`, { password: pw });
      toast('Password reset');
    })));
    $$('[data-act]', el).forEach((b) => (b.onclick = busy(b, async () => { await api.put(`/admin/staff/${b.dataset.act}`, { active: b.dataset.on !== '1' }); reload(); })));
  },

  async settings(el) {
    const [s, care] = await Promise.all([api.get('/admin/settings'), api.get('/admin/contact')]);
    const L = {
      min_redeem_points: 'Minimum points per redemption', max_redeem_points: 'Maximum points per redemption (0 = no limit)',
      require_otp_for_mobile_redemption: 'Require customer OTP when redeeming via mobile search (1 = yes, 0 = no)',
      missing_bill_grace_days: 'Days before an unbilled redemption is flagged "missing billing entry"', notif_daily_cap: 'Max promotional notifications per customer per day',
    };
    el.innerHTML = `
      ${head('Settings')}
      <div class="card" style="max-width:640px">
        <div class="alert info small" style="margin-bottom:12px">Earning rule: <b>₹200 eligible spend = 1 point</b> (truncated to 2 decimals). Point value: <b>₹2</b>. These are fixed business rules in V1.</div>
        ${Object.entries(L).map(([k, l]) => `<div class="field"><label>${l}</label><input data-k="${k}" value="${s[k]}" inputmode="decimal" /></div>`).join('')}
        <p class="small muted">Segmentation thresholds are on the <a href="#/segments">Segmentation</a> page.</p>
        <button class="btn-primary" id="ss">Save settings</button>
      </div>
      <div class="card" style="max-width:640px;margin-top:16px">
        <h2>Customer care</h2>
        <p class="small muted">Shown to customers under <b>Stores &amp; contact</b> in the Customer App for complaints and help. Branch addresses and numbers are set in <a href="#/branches">Branches &amp; staff</a>.</p>
        <div class="inline-fields"><div class="field"><label>Customer care number</label><input id="cph" inputmode="tel" value="${esc(care.care_phone || '')}" placeholder="1800 123 4567" /></div>
          <div class="field"><label>Customer care WhatsApp</label><input id="cwa" inputmode="tel" value="${esc(care.care_whatsapp || '')}" placeholder="98400 00000" /></div></div>
        <div class="inline-fields"><div class="field"><label>Email (optional)</label><input id="cem" type="email" value="${esc(care.care_email || '')}" placeholder="care@vasantham.in" /></div>
          <div class="field"><label>Hours (optional)</label><input id="chr" value="${esc(care.care_hours || '')}" placeholder="Mon–Sat, 9 AM – 8 PM" /></div></div>
        <button class="btn-primary" id="cs">Save customer care</button>
      </div>`;
    const b = $('#ss');
    b.onclick = busy(b, async () => { await api.put('/admin/settings', Object.fromEntries($$('[data-k]', el).map((i) => [i.dataset.k, i.value]))); toast('Settings saved'); });
    const cb = $('#cs');
    cb.onclick = busy(cb, async () => {
      await api.put('/admin/contact', { care_phone: $('#cph').value, care_whatsapp: $('#cwa').value, care_email: $('#cem').value, care_hours: $('#chr').value });
      toast('Customer care details saved');
      VIEWS.settings(el);
    });
  },

  async audit(el, _a, pg = 1) {
    const f = { action: $('#aa')?.value ?? '', actor: $('#at')?.value ?? '', page: pg };
    const d = await api.get(`/admin/audit?${qs(f)}`);
    el.innerHTML = `
      ${head('Audit logs')}
      <div class="filters"><select id="aa"><option value="">All actions</option>${d.actions.map((a) => `<option ${f.action === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
        <select id="at"><option value="">All actors</option>${['ADMIN', 'MANAGER', 'CUSTOMER', 'SYSTEM'].map((a) => `<option ${f.actor === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
        <button class="btn-primary" id="ago">Filter</button></div>
      <div class="table-wrap"><table><tr><th>Time</th><th>Actor</th><th>Branch</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr>
        ${d.rows.map((a) => `<tr><td class="small" style="white-space:nowrap">${dt(a.created_at)}</td><td>${esc(a.actor_name || '')}<div class="tiny muted">${esc(a.actor_type)}</div></td><td>${esc(a.branch || '')}</td>
          <td><b class="small">${esc(a.action)}</b></td><td class="small">${esc(a.entity || '')} ${esc(a.entity_id || '')}</td>
          <td class="tiny" style="max-width:380px;word-break:break-word">${esc(a.details || '')}</td><td class="tiny">${esc(a.ip || '')}</td></tr>`).join('')}
      </table></div>`;
    pager(el, d, (p) => VIEWS.audit(el, null, p));
    $('#ago').onclick = () => VIEWS.audit(el);
  },
};

/* ---------------- shared admin widgets ---------------- */
function importResult(r) {
  const errs = r.errors || [];
  return `<div class="card stack">
    <div class="row between"><h2 style="margin:0">Upload result <span class="badge blue" style="vertical-align:middle">${(r.mode || r.calc_mode) === 'POINTS' ? 'Points given in file' : 'Points from amount'}</span></h2><span class="badge ${r.status === 'COMPLETED' ? 'green' : r.status === 'FAILED' ? 'red' : 'warn'}">${esc((r.status || '').replace(/_/g, ' '))}</span></div>
    <div class="grid k4">
      ${kpi('Bills imported', num(r.imported), `${num(r.items)} item lines`)}${kpi('Duplicates skipped', num(r.duplicate))}${kpi('Bills with errors', num(r.error ?? 0))}
      ${kpi('New customers', num(r.newCustomers))}${kpi('Points credited', pts(r.creditedCp))}${kpi('Points reversed', pts(r.reversedCp))}
      ${kpi('Redemptions reconciled', num(r.reconciled))}${kpi('Reconciliation issues', num(r.issues), r.issues ? '<a href="#/reconciliation">Review</a>' : '')}
    </div>
    ${errs.length ? `<h3>Row messages (${errs.length})</h3><div class="table-wrap" style="max-height:340px;overflow:auto"><table><tr><th>Row</th><th>Bill</th><th>Level</th><th>Message</th></tr>
      ${errs.map((e) => `<tr><td>${e.rowNo ?? e.row_no ?? ''}</td><td>${esc(e.billNo ?? e.bill_no ?? '')}</td><td><span class="badge ${e.level === 'ERROR' ? 'red' : 'warn'}">${esc(e.level)}</span></td><td class="small">${esc(e.message)}</td></tr>`).join('')}</table></div>` : '<div class="alert ok">No errors.</div>'}
  </div>`;
}

function redemptionsTable(rows) {
  return `<div class="table-wrap"><table><tr><th>ID</th><th>Created</th><th>Customer</th><th>Redemption</th><th class="num">Value</th><th>Business / outlet / approver</th><th>Status</th><th>Bill</th></tr>
    ${rows.map((r) => `<tr class="click" data-red="${esc(r.id)}"><td><b>${esc(r.id)}</b><div class="tiny muted">${esc(r.requested_via)}${r.verified_by ? ` · ${esc(r.verified_by)}` : ''}</div></td><td class="small">${dt(r.created_at)}</td>
      <td>${esc(r.mobile || '')}<div class="tiny muted">${esc(r.customer_name || '')}</div></td><td>${r.kind === 'POINTS' ? `${pts(r.cp)} points` : esc(r.offer_title || 'Offer')}</td><td class="num">${inr(r.value_paise)}</td>
      <td class="small">${r.business ? `<b>${esc(r.business)}</b><br/>` : ''}${esc(r.branch || '—')}<div class="tiny muted">${esc(r.approved_by_name || '')}</div></td><td>${statusBadge(r.status)}${r.recon_status && r.recon_status !== 'MATCHED' ? `<div class="tiny muted">${esc(r.recon_status)}</div>` : ''}</td>
      <td class="small">${esc(r.bill_no || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No redemptions</td></tr>'}</table></div>`;
}
function bindRedemptionRows(el, reload) {
  $$('[data-red]', el).forEach((tr) => (tr.onclick = () => redemptionModal(tr.dataset.red, reload)));
}

async function redemptionModal(id, reload) {
  const r = await api.get(`/admin/redemptions/${encodeURIComponent(id)}`);
  const reversible = ['APPROVED', 'SUBMITTED', 'BILLED', 'RECONCILED', 'CREATED'].includes(r.status);
  const reconcilable = ['APPROVED', 'SUBMITTED', 'BILLED'].includes(r.status);
  const m = modal(`
    <div class="row between"><h2>${esc(r.id)}</h2><button data-close class="btn-sm">Close</button></div>
    <dl class="kv"><dt>Status</dt><dd>${statusBadge(r.status)}</dd><dt>Customer</dt><dd>${esc(r.customer_name || '')} ${esc(r.customer_mobile_masked)}</dd>
      <dt>Redemption</dt><dd>${r.kind === 'POINTS' ? `${esc(r.points)} points` : esc(r.offer)} · <b>${esc(r.value)}</b></dd>
      <dt>Business</dt><dd>${esc(r.business || '—')}</dd><dt>Type</dt><dd>${esc(r.type_label)}${r.coupon_code ? ` · ${esc(r.coupon_code)}` : ''}</dd>
      <dt>Branch</dt><dd>${esc(r.branch || '—')}</dd>${r.bill ? `<dt>Bill</dt><dd>${esc(r.bill)}${r.partner_bill_no ? ` · ${esc(r.partner_bill_no)}` : ''}</dd>` : ''}<dt>Approved by</dt><dd>${esc(r.approved_by || '—')} ${esc(r.approved_at || '')}</dd>
      ${r.cancel_reason ? `<dt>Reason</dt><dd>${esc(r.cancel_reason)}</dd>` : ''}</dl>
    <h3 style="margin-top:12px">Lifecycle</h3>
    <table>${r.events.map((e) => `<tr><td class="small">${dt(e.created_at)}</td><td class="small">${esc(e.from_status || '—')} → <b>${esc(e.to_status)}</b></td><td class="small">${esc(e.actor_type)}${e.note ? ` · ${esc(e.note)}` : ''}</td></tr>`).join('')}</table>
    <div class="row" style="margin-top:12px">
      ${reversible ? '<button class="btn-danger btn-sm" id="rev">Cancel / reverse</button>' : ''}
      ${reconcilable ? '<button class="btn-sm" id="rec">Mark reconciled manually</button>' : ''}
    </div>
    <div id="act" style="margin-top:10px"></div>`);
  $('#rev', m.el)?.addEventListener('click', () => {
    $('#act', m.el).innerHTML = `<div class="field"><label>Reason (required)</label><select id="rr"><option value="">Select…</option>${['Customer changed mind', 'Billing cancelled', 'Wrong redemption amount', 'Duplicate transaction', 'Other'].map((x) => `<option>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Details</label><input id="rnote" /></div><button class="btn-danger" id="rgo">Confirm</button>`;
    const g = $('#rgo', m.el);
    g.onclick = busy(g, async () => {
      await api.post(`/admin/redemptions/${encodeURIComponent(id)}/cancel`, { reason: $('#rr', m.el).value, note: $('#rnote', m.el).value });
      toast('Done');
      m.close();
      reload?.();
    });
  });
  $('#rec', m.el)?.addEventListener('click', () => {
    $('#act', m.el).innerHTML = `<div class="field"><label>Note (required)</label><input id="rcn" placeholder="e.g. Verified against paper bill B1042" /></div><button class="btn-primary" id="rcgo">Confirm</button>`;
    const g = $('#rcgo', m.el);
    g.onclick = busy(g, async () => {
      await api.post(`/admin/redemptions/${encodeURIComponent(id)}/reconcile`, { note: $('#rcn', m.el).value });
      toast('Marked reconciled');
      m.close();
      reload?.();
    });
  });
}

async function billModal(id) {
  const b = await api.get(`/admin/purchases/${id}`);
  modal(`<div class="row between"><h2>Bill ${esc(b.bill_no)}</h2><button data-close class="btn-sm">Close</button></div>
    <p class="small muted">${esc(b.branch)} · ${dateOnly(b.bill_date)} ${esc(b.bill_time || '')} · ${esc(b.bill_type)} · Upload #${b.import_id}</p>
    ${b.items.length ? `<div class="table-wrap"><table><tr><th>Code</th><th>Product</th><th>Category</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Discount</th><th class="num">Amount</th></tr>
      ${b.items.map((i) => `<tr><td>${esc(i.product_code || '')}</td><td>${esc(i.product_name || '')}</td><td>${esc(i.category || '')}</td><td class="num">${i.qty ?? ''}</td>
        <td class="num">${i.rate_paise != null ? inr(i.rate_paise) : ''}</td><td class="num">${i.discount_paise != null ? inr(i.discount_paise) : ''}</td><td class="num">${i.amount_paise != null ? inr(i.amount_paise) : ''}</td></tr>`).join('')}</table></div>` : '<p class="muted small">No item-level data for this bill.</p>'}
    <dl class="kv" style="margin-top:10px"><dt>Bill value</dt><dd>${inr(b.bill_value_paise)}</dd><dt>Discount</dt><dd>${inr(b.discount_paise)}</dd><dt>Net eligible</dt><dd><b>${inr(b.net_paise)}</b></dd>
      <dt>Exact points</dt><dd>${b.raw_points}</dd><dt>Credited</dt><dd>${pts(b.credited_cp)}${b.reversed_cp ? ` (reversed ${pts(b.reversed_cp)})` : ''}</dd>
      ${b.loyalty_ref ? `<dt>Loyalty ref</dt><dd>${esc(b.loyalty_ref)} · ${b.loyalty_discount_paise != null ? inr(b.loyalty_discount_paise) : 'no amount'}</dd>` : ''}</dl>`, { wide: true });
}

const OFFER_FIELDS = {
  SPEND_GET_OFF: ['min_spend', 'value'], CATEGORY_OFFER: ['category', 'product', 'min_spend', 'value'], FREE_PRODUCT: ['product', 'min_spend', 'value'],
  PERSONAL_DISCOUNT: ['min_spend', 'value'], BIRTHDAY: ['min_spend', 'value'], COMEBACK: ['min_spend', 'value'],
  BONUS_POINTS: ['bonus_points', 'min_spend'], MULTIPLIER: ['multiplier', 'min_spend', 'category', 'product'], COUPON: ['min_spend', 'value'],
};
const FIELD_LABEL = {
  min_spend: 'Minimum bill (₹)', value: 'Offer value (₹ discount / cost)', category: 'Category', product: 'Product name or code',
  bonus_points: 'Bonus points', multiplier: 'Points multiplier (e.g. 2 = double)',
};
function offerFields(o = {}, { campaign = false } = {}) {
  const t = o.type || 'SPEND_GET_OFF';
  const val = (k) => ({ min_spend: o.min_spend_paise != null ? o.min_spend_paise / 100 : '', value: o.value_paise != null ? o.value_paise / 100 : '', bonus_points: o.bonus_cp ? o.bonus_cp / 100 : '', multiplier: o.multiplier || '', category: o.category || '', product: o.product || '' })[k];
  const selBranches = (o.branch_ids || '').split(',').filter(Boolean);
  const bizId = o.business_id || ownerBiz()?.id;
  return `
    <div class="inline-fields">
      <div class="field"><label>Business (where it is used)</label><select id="of-biz">${bizOptions(bizId, '')}</select></div>
      <div class="field"><label>Offer type</label><select id="of-type">${Object.entries(offerTypes).map(([k, v]) => `<option value="${k}" ${k === t ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
      ${campaign ? '' : `<div class="field"><label>Audience</label><select id="of-aud"><option value="GLOBAL" ${o.audience !== 'PERSONAL' ? 'selected' : ''}>Everyone (global)</option><option value="PERSONAL" ${o.audience === 'PERSONAL' ? 'selected' : ''}>Personalised (assigned customers)</option></select></div>`}
    </div>
    <div class="field"><label>Title</label><input id="of-title" value="${esc(o.title || '')}" placeholder="${campaign ? 'Defaults to campaign name' : 'e.g. ₹100 off on ₹1,500'}" /></div>
    <div class="field"><label>Description (shown to customers)</label><input id="of-desc" value="${esc(o.description || '')}" /></div>
    <div class="inline-fields">${Object.keys(FIELD_LABEL).map((k) => `<div class="field" data-f="${k}"><label>${FIELD_LABEL[k]}</label><input id="of-${k}" value="${esc(val(k))}" /></div>`).join('')}</div>
    <div class="inline-fields">
      ${campaign ? '' : `<div class="field"><label>Valid from</label><input type="date" id="of-from" value="${o.valid_from || todayIST()}" /></div><div class="field"><label>Valid to</label><input type="date" id="of-to" value="${o.valid_to || ''}" /></div>`}
      <div class="field"><label>Max uses per customer</label><input id="of-uses" value="${o.max_uses_per_customer || 1}" inputmode="numeric" /></div>
      <div class="field"><label>Coupon code (optional)</label><input id="of-coupon" value="${esc(o.coupon_code || '')}" /></div>
    </div>
    <div data-rw>
      <h3 style="margin-top:6px">Reward</h3>
      <div class="inline-fields">
        <div class="field"><label>Points needed (0 = promotional unlock, no points)</label><input id="of-pcost" inputmode="decimal" value="${o.points_cost_cp ? o.points_cost_cp / 100 : ''}" placeholder="0" /></div>
        <div class="field"><label>Internal cost ₹ (blank = same as value)</label><input id="of-cost" inputmode="decimal" value="${o.cost_paise != null ? o.cost_paise / 100 : ''}" /></div>
        <div class="field"><label>Who funds it</label><select id="of-fund">${Object.entries(bizMeta.fundingTypes).map(([k, l]) => `<option value="${k}" ${(o.funding_type || 'PROGRAM') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="field" data-fund><label>Funding partner</label><select id="of-funder">${businesses.filter((b) => !b.is_program_owner).map((b) => `<option value="${b.id}" ${String(o.funder_business_id || (o.business_id !== ownerBiz()?.id ? o.business_id : '')) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
        <div class="field" data-share><label>Partner's share of the cost (₹)</label><input id="of-share" inputmode="decimal" value="${o.partner_share_paise ? o.partner_share_paise / 100 : ''}" /></div>
      </div>
      <div class="field"><label>Terms &amp; conditions (shown to customers)</label><textarea id="of-terms" rows="2">${esc(o.terms || '')}</textarea></div>
    </div>
    <div class="field" data-tgt><label>Show only to these segments (optional, offers for everyone only)</label>
      <div class="row" style="max-height:130px;overflow:auto">${segOptions.map((s) => `<label class="chk"><input type="checkbox" data-seg="${esc(s.code)}" ${(o.target_segments || '').split(',').includes(s.code) ? 'checked' : ''} /> ${esc(s.label)} <span class="tiny muted">(${num(s.n)})</span></label>`).join('')}</div>
      <div class="tiny muted">E.g. show an MF Nuts coupon only to the "Nuts &amp; health" interest segment. Leave empty to show it to everyone.</div></div>
    <div class="field"><label>Outlets (none selected = all outlets of the business)</label><div class="row">${branches.map((b) => `<label data-bbiz="${b.business_id}" style="display:flex;gap:4px;color:var(--text);font-weight:500"><input type="checkbox" data-br="${b.id}" style="width:auto" ${selBranches.includes(String(b.id)) ? 'checked' : ''} />${esc(b.name)}</label>`).join('')}</div></div>
    <div class="field"><label>Offer image or PDF (optional, shown to customers in the app)</label>
      ${o.attachment ? `<div class="row small" style="margin-bottom:6px">${attachmentLink(o.attachment)}
        <label style="display:flex;gap:4px;color:var(--text);font-weight:500;margin:0"><input type="checkbox" id="of-att-rm" style="width:auto" /> Remove</label></div>` : ''}
      <input type="file" id="of-att" accept="image/jpeg,image/png,image/webp,application/pdf" />
      <div class="tiny muted">JPG, PNG, WebP or PDF, up to 10 MB.${o.attachment ? ' Choosing a new file replaces the current one.' : ''} A poster or flyer works best in portrait or square.</div></div>`;
}
const attachmentLink = (a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${a.kind === 'pdf' ? '📄' : '🖼️'} ${esc(a.name || (a.kind === 'pdf' ? 'PDF' : 'Image'))}</a>`;
/** Upload / remove the offer attachment chosen in offerFields, after the offer itself is saved. */
async function saveAttachment(el, offerId) {
  const f = $('#of-att', el)?.files?.[0];
  if (f) {
    if (f.size > 10 * 1024 * 1024) throw new Error('File is too large (max 10 MB)');
    await api.call('POST', `/admin/offers/${offerId}/attachment?${qs({ filename: f.name })}`, undefined, { raw: f });
  } else if ($('#of-att-rm', el)?.checked) {
    await api.call('DELETE', `/admin/offers/${offerId}/attachment`);
  }
}
function wireOfferFields(el) {
  const sync = () => {
    const t = $('#of-type', el).value;
    $$('[data-f]', el).forEach((f) => f.classList.toggle('hidden', !OFFER_FIELDS[t].includes(f.dataset.f)));
    const biz = $('#of-biz', el).value;
    $$('[data-bbiz]', el).forEach((l) => {
      const mine = l.dataset.bbiz === biz;
      l.classList.toggle('hidden', !mine);
      if (!mine) $('input', l).checked = false;
    });
    $('[data-rw]', el).classList.toggle('hidden', !offerTypes[t]?.redeemable);
    const fund = $('#of-fund', el).value;
    $('[data-fund]', el).classList.toggle('hidden', fund === 'PROGRAM');
    $('[data-share]', el).classList.toggle('hidden', fund !== 'SHARED');
    const audSel = $('#of-aud', el);
    $('[data-tgt]', el).classList.toggle('hidden', !audSel || audSel.value === 'PERSONAL');
    const aud = $('#of-aud', el);
    if (aud && offerTypes[t]?.personalOnly) { aud.value = 'PERSONAL'; aud.disabled = true; } else if (aud) aud.disabled = false;
  };
  $('#of-type', el).onchange = sync;
  $('#of-biz', el).onchange = sync;
  $('#of-fund', el).onchange = sync;
  if ($('#of-aud', el)) $('#of-aud', el).addEventListener('change', sync);
  sync();
}
function readOffer(el) {
  const v = (id) => $(`#of-${id}`, el)?.value?.trim();
  return {
    type: v('type'), audience: v('aud'), title: v('title'), description: v('desc'), min_spend: v('min_spend'), value: v('value'), category: v('category'), product: v('product'),
    bonus_points: v('bonus_points'), multiplier: v('multiplier'), valid_from: v('from'), valid_to: v('to'), max_uses_per_customer: v('uses'), coupon_code: v('coupon'),
    branch_ids: $$('[data-br]', el).filter((c) => c.checked).map((c) => Number(c.dataset.br)),
    business_id: Number(v('biz')), points_cost: v('pcost'), cost: v('cost'), funding_type: v('fund'),
    funder_business_id: v('fund') === 'PROGRAM' ? null : Number(v('funder')) || null, partner_share: v('share'), terms: v('terms'),
    target_segments: $$('[data-seg]', el).filter((c) => c.checked).map((c) => c.dataset.seg),
  };
}

function offerForm(o, done) {
  const m = modal(`<div class="row between"><h2>${o ? 'Edit offer' : 'New offer'}</h2><button data-close class="btn-sm">Close</button></div>
    ${offerFields(o || {})}
    <div class="row"><button class="btn-primary" id="osave">${o ? 'Save changes' : 'Create offer'}</button></div>`, { wide: true });
  wireOfferFields(m.el);
  const s = $('#osave', m.el);
  s.onclick = busy(s, async () => {
    const body = { ...readOffer(m.el), active: o ? !!o.active : true };
    const id = o ? o.id : (await api.post('/admin/offers', body)).id;
    if (o) await api.put(`/admin/offers/${o.id}`, body);
    try {
      await saveAttachment(m.el, id);
    } catch (e) {
      toast(`Offer saved, but the attachment failed: ${e.message}`, true);
      m.close();
      return done();
    }
    toast('Offer saved');
    m.close();
    done();
  });
}

async function assignForm(o, done) {
  const segs = await api.get('/admin/segments');
  const m = modal(`<h2>Assign "${esc(o.title)}"</h2>
    <div class="field"><label>Assign to a segment</label><select id="as"><option value="">— or enter mobiles below —</option>${segs.counts.map((s) => `<option value="${esc(s.segment)}">${esc(s.label)} (${s.n})</option>`).join('')}</select></div>
    <div class="field"><label>Mobile numbers (comma or new line separated)</label><textarea id="am" rows="4"></textarea></div>
    <div class="field"><label>Expires on (optional, else offer end date)</label><input type="date" id="ae" /></div>
    <div class="row"><button class="btn-primary" id="ago">Assign</button><button data-close>Cancel</button></div>`);
  const g = $('#ago', m.el);
  g.onclick = busy(g, async () => {
    const r = await api.post(`/admin/offers/${o.id}/assign`, { segment: $('#as', m.el).value || undefined, mobiles: $('#am', m.el).value, expires_on: $('#ae', m.el).value });
    toast(`Assigned to ${r.assigned} customers${r.notFound.length ? ` · ${r.notFound.length} not found` : ''}`);
    m.close();
    done();
  });
}

async function campaignForm(segment = '') {
  if (!Object.keys(offerTypes).length) offerTypes = await api.get('/admin/offers/types');
  const segs = await api.get('/admin/segments');
  const m = modal(`<div class="row between"><h2>New campaign</h2><button data-close class="btn-sm">Close</button></div>
    <div class="inline-fields">
      <div class="field"><label>Campaign name</label><input id="cn" placeholder="e.g. Dormant win-back September" /></div>
      <div class="field"><label>Target segment</label><select id="cs"><option value="ALL">All customers</option>${segs.counts.map((s) => `<option value="${esc(s.segment)}" ${s.segment === segment ? 'selected' : ''}>${esc(s.label)} (${s.n})</option>`).join('')}</select></div>
      <div class="field"><label>Start date</label><input type="date" id="cst" value="${todayIST()}" /></div>
      <div class="field"><label>Validity (days)</label><input id="cv" value="7" inputmode="numeric" /></div>
    </div>
    <h3>Offer</h3>
    ${offerFields({ type: 'COMEBACK' }, { campaign: true })}
    <div class="field"><label>Notes</label><input id="cnotes" /></div>
    <button class="btn-primary" id="cgo">Launch campaign</button>`, { wide: true });
  wireOfferFields(m.el);
  const g = $('#cgo', m.el);
  g.onclick = busy(g, async () => {
    const r = await api.post('/admin/campaigns', { name: $('#cn', m.el).value, segment: $('#cs', m.el).value, start_date: $('#cst', m.el).value, validity_days: $('#cv', m.el).value, notes: $('#cnotes', m.el).value, offer: readOffer(m.el) });
    try {
      await saveAttachment(m.el, r.offer_id);
      toast(`Campaign launched to ${r.audience} customers`);
    } catch (e) {
      toast(`Campaign launched, but the attachment failed: ${e.message}. Add it from Offers → Edit.`, true);
    }
    m.close();
    location.hash = `#/campaign/${r.id}`;
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    me = await api.get('/admin/me');
    const opt = (perm, url, dflt) => (canAny(perm) ? api.get(url) : Promise.resolve(dflt));
    let segs;
    [branches, offerTypes, segs, businesses, bizMeta, segOptions] = await Promise.all([
      opt('branches.view', '/admin/branches', []), opt('offers.view', '/admin/offers/types', {}), opt('customers.view|analytics.view', '/admin/segments', { labels: {} }),
      opt('businesses.view', '/admin/businesses', []), opt('businesses.view', '/admin/businesses/meta', { limitTypes: {}, billingSources: {}, settlementCycles: [], fundingTypes: {} }),
      opt('offers.view|engagement.view', '/admin/segments/options', []),
    ]);
    segLabels = segs.labels;
    route();
  } catch (e) {
    if (e.status === 401 || e.status === 403) { api.token = null; renderLogin(); } else root.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}
if (api.token) boot();
else renderLogin();
