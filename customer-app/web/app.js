import { makeApi, esc, $, $$, pts, inr, dt, dateOnly, toast, modal, busy, statusBadge, LEDGER_LABEL } from '/shared/lib.js';

import { firebaseOtp, otpMode, tenDigitMobile } from '/shared/otp.js';

const api = makeApi('vl_customer_token');
const root = $('#root');
let state = { tab: 'home', home: null, bizId: null, market: null };
// a shared referral link (/customer?ref=CODE) is remembered until the new customer signs up
try {
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref) sessionStorage.setItem('vl_ref', ref.trim().toUpperCase().slice(0, 12));
} catch { /* storage unavailable */ }
const pendingRef = () => { try { return sessionStorage.getItem('vl_ref') || ''; } catch { return ''; } };
let timers = [];
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
api.onUnauthorized = () => renderLogin();

const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  offers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>',
  points: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 10h4.5a1.5 1.5 0 0 1 0 3H9"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  call: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21l1.6-4.8A8.5 8.5 0 1 1 8 19.6z"/><path d="M9 9.5c.3 2 2.3 4.2 4.5 4.8l1-1.2 1.8.8c-.2 1-1 1.8-2 1.8-3 0-6.5-3.4-6.5-6.4 0-1 .8-1.8 1.8-2l.8 1.8z"/></svg>',
  map: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  mail: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>',
};

/* ---------------- login ---------------- */
function renderLogin() {
  clearTimers();
  root.innerHTML = `
    <div class="login stack">
      <div class="logo">Vasantham <span>Rewards</span></div>
      <p class="muted">Earn 1 point for every ₹200 you spend. Each point is worth ₹2 at any Vasantham store.</p>
      <div class="card stack" id="step1">
        <div class="field"><label for="mobile">Mobile number</label>
          <input id="mobile" inputmode="numeric" autocomplete="tel" maxlength="14" placeholder="10-digit mobile number" /></div>
        <p class="small muted">Use the number you give at the billing counter. Your earlier purchases and points will appear automatically.</p>
        <button class="btn-primary btn-block btn-lg" id="send">Get OTP</button>
      </div>
      <div class="card stack hidden" id="step2">
        <div class="field"><label for="otp">Enter the 6-digit OTP sent to <b id="sentTo"></b></label>
          <input id="otp" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" /></div>
        <div id="devHint" class="alert info hidden"></div>
        <button class="btn-primary btn-block btn-lg" id="verify">Verify &amp; continue</button>
        <button class="btn-ghost btn-block" id="back">Change number</button>
      </div>
    </div>`;
  let fb = null; // Firebase OTP session when the server uses Firebase
  const send = $('#send');
  send.onclick = busy(send, async () => {
    const mobile = $('#mobile').value;
    let r;
    if ((await otpMode(api)) === 'firebase') {
      const m = tenDigitMobile(mobile);
      if (!m) throw new Error('Enter a valid 10-digit mobile number');
      fb = await firebaseOtp(api);
      r = await fb.send(m);
    } else {
      fb = null;
      r = await api.post('/auth/customer/otp', { mobile });
    }
    $('#sentTo').textContent = mobile;
    $('#step1').classList.add('hidden');
    $('#step2').classList.remove('hidden');
    $('#devHint').classList.toggle('hidden', !r.devOtp);
    if (r.devOtp) {
      $('#devHint').textContent = `Demo mode — no SMS gateway configured. Your OTP is ${r.devOtp}`;
    }
    $('#otp').focus();
  });
  $('#mobile').addEventListener('keydown', (e) => e.key === 'Enter' && send.click());
  const verify = $('#verify');
  verify.onclick = busy(verify, async () => {
    const r = fb
      ? await api.post('/auth/customer/firebase', { idToken: await fb.verify($('#otp').value) })
      : await api.post('/auth/customer/verify', { mobile: $('#mobile').value, otp: $('#otp').value });
    api.token = r.token;
    state.home = null;
    if (!r.customer.profile_complete) return renderProfileSetup(r.customer, r.newAccount ? 'new' : 'found');
    if (!r.newAccount && r.firstLogin) toast(`Welcome! We found your account with ${r.customer.balance} points.`);
    go('home');
  });
  $('#otp').addEventListener('keydown', (e) => e.key === 'Enter' && verify.click());
  $('#back').onclick = () => { $('#step2').classList.add('hidden'); $('#step1').classList.remove('hidden'); };
}

const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

/** mode: 'new' (just enrolled), 'found' (existing POS account), 'complete' (profile missing details) */
function renderProfileSetup(c, mode) {
  const lock = (v) => (v ? `value="${esc(v)}" disabled` : '');
  root.innerHTML = `
    <div class="login stack">
      <div class="logo">${mode === 'complete' ? 'Complete your profile' : `Welcome${mode === 'new' ? '' : ' back'}!`}</div>
      ${mode === 'found' ? `<div class="alert ok">We found your Vasantham account with <b>${esc(c.balance)} points</b>.</div>` : ''}
      <div class="card stack">
        <div class="field"><label for="name">Your name</label><input id="name" autocomplete="name" value="${esc(c.name || '')}" /></div>
        <p class="small muted" style="margin:0">Enter your <b>birthday or wedding anniversary</b> (at least one) — we'll send you a special reward on that day.</p>
        <div class="field"><label for="dob">Date of birth</label><input id="dob" type="date" max="${today()}" ${lock(c.dob)} /></div>
        <div class="field"><label for="ann">Wedding anniversary</label><input id="ann" type="date" max="${today()}" ${lock(c.anniversary)} /></div>
        ${mode === 'new' ? `<div class="field"><label for="refc">Referral code <span class="muted">(optional)</span></label><input id="refc" value="${esc(pendingRef())}" placeholder="From a friend, e.g. VRAB12CD" autocapitalize="characters" /></div>` : ''}
        <div id="perr" class="alert error hidden"></div>
        <button class="btn-primary btn-block btn-lg" id="save">Continue</button>
      </div>
    </div>`;
  const b = $('#save');
  b.onclick = busy(b, async () => {
    const body = { name: $('#name').value.trim(), dob: c.dob ? undefined : $('#dob').value || null, anniversary: c.anniversary ? undefined : $('#ann').value || null };
    const err = !body.name ? 'Please enter your name' : !(c.dob || body.dob || c.anniversary || body.anniversary) ? 'Please enter your date of birth or wedding anniversary' : '';
    $('#perr').textContent = err;
    $('#perr').classList.toggle('hidden', !err);
    if (err) return;
    await api.put('/me', body);
    const code = $('#refc')?.value.trim();
    if (code) {
      try {
        await api.post('/me/referral', { code });
        toast('Referral code applied. Your welcome reward unlocks with your first Vasantham purchase.');
      } catch (e) {
        toast(`Referral code not applied: ${e.message}`, true);
      }
      try { sessionStorage.removeItem('vl_ref'); } catch { /* ignore */ }
    }
    state.home = null;
    go('home');
  });
}

/* ---------------- shell ---------------- */
function shell(content) {
  const unread = state.home?.unread;
  root.innerHTML = `
    <header class="app"><div class="row">
      <div class="brand">Vasantham <span>Rewards</span></div>
      <button id="bell" aria-label="Notifications">${ICON.bell}${unread ? '<span class="dot"></span>' : ''}</button>
    </div></header>
    <main id="main">${content}</main>
    <nav class="tabs">
      ${[['home', 'Home'], ['offers', 'Rewards'], ['qr', 'My QR'], ['points', 'Points'], ['more', 'Account']]
        .map(([k, l]) => `<button data-tab="${k}" class="${state.tab === k ? 'active' : ''} ${k === 'qr' ? 'qr-tab' : ''}">${ICON[k]}${l}</button>`).join('')}
    </nav>`;
  $$('nav.tabs button').forEach((b) => (b.onclick = () => go(b.dataset.tab)));
  if (state.tab === 'business') $('nav.tabs [data-tab="offers"]')?.classList.add('active');
  $('#bell').onclick = () => go('notifications');
}

async function go(tab) {
  clearTimers();
  state.tab = tab;
  shell('<div class="spinner"></div>');
  try {
    if (!state.home) state.home = await api.get('/me');
    if (!state.home.customer.profile_complete) return renderProfileSetup(state.home.customer, 'complete');
    await (VIEWS[tab] || VIEWS.home)();
  } catch (e) {
    if (e.status !== 401) $('#main').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

/* ---------------- stores & contact ---------------- */
const telHref = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
const waHref = (n, text) => `https://wa.me/${encodeURIComponent(n)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
const mapHref = (b) => b.map_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(['Vasantham', b.name, b.address].filter(Boolean).join(', '))}`;
const contactBtn = (href, icon, label, cls = '') => `<a class="btn btn-sm ${cls}" href="${esc(href)}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${icon}${label}</a>`;

const bizLogo = (b, size = 44) => b.logo_url
  ? `<img class="biz-logo" src="${esc(b.logo_url)}" alt="" style="width:${size}px;height:${size}px" />`
  : `<div class="biz-logo biz-initials" style="width:${size}px;height:${size}px">${esc(b.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase())}</div>`;

/* ---------------- challenges ---------------- */
function challengeCard(ch) {
  const periodWord = ch.period === 'MONTHLY' ? 'this month' : ch.period === 'WEEKLY' ? 'this week' : '';
  const left = ch.days_left === 0 ? 'Last day' : `${ch.days_left} day${ch.days_left === 1 ? '' : 's'} left`;
  let body;
  if (ch.type === 'SPEND') {
    const pctDone = Math.min(100, Math.round((ch.progress / Math.max(1, ch.target)) * 100));
    body = `<div class="ch-amount"><b>${inr(ch.progress)}</b> / ${inr(ch.target)}</div>
      <div class="bar-track"><i style="width:${pctDone}%"></i></div>`;
  } else {
    const n = ch.target;
    body = `<div class="visits">${Array.from({ length: n }, (_, i) => `<div class="visit ${i < ch.progress ? 'done' : ''}"><span>${i < ch.progress ? '✓' : i + 1}</span><small>Visit ${i + 1}</small></div>`).join('')}</div>
      ${ch.min_bill_paise ? `<div class="tiny muted">Bills of ${inr(ch.min_bill_paise)} or more count as a visit. One visit per day.</div>` : ''}`;
  }
  const next = ch.completed
    ? `<div class="small pos">All rewards unlocked ${periodWord} 🎉</div>`
    : `<div class="small">${ch.type === 'SPEND' ? `<b>${inr(ch.remaining)}</b> more` : `<b>${ch.remaining}</b> more visit${ch.remaining === 1 ? '' : 's'}`} to unlock <b>${esc(ch.next_reward)}</b></div>`;
  return `<div class="card challenge">
    <div class="row between"><b>${esc(ch.name)}</b><span class="tiny muted">${left}</span></div>
    ${ch.description ? `<div class="tiny muted">${esc(ch.description)}</div>` : ''}
    ${body}${next}
    ${ch.tiers.length > 1 ? `<div class="tiers">${ch.tiers.map((t) => `<span class="badge ${t.achieved ? 'green' : ''}">${t.achieved ? '✓ ' : ''}${esc(t.label)} → ${esc(t.reward)}</span>`).join('')}</div>` : ''}
  </div>`;
}

/* ---------------- offer images / PDFs ---------------- */
const offerMedia = (a, alt) => !a ? '' : a.kind === 'pdf'
  ? `<a class="btn btn-sm offer-pdf" href="${esc(a.url)}" target="_blank" rel="noopener">📄 View offer (PDF)</a>`
  : `<img class="offer-img" src="${esc(a.url)}" alt="${esc(alt)}" loading="lazy" data-zoom="${esc(a.url)}" />`;

function bindMedia(root = document) {
  $$('[data-zoom]', root).forEach((img) => (img.onclick = () => modal(`
    <div class="row between"><h2 style="margin:0">${esc(img.alt)}</h2><button data-close class="btn-sm">Close</button></div>
    <img src="${esc(img.dataset.zoom)}" alt="${esc(img.alt)}" style="width:100%;margin-top:10px;border-radius:10px" />
    <a class="btn btn-sm" href="${esc(img.dataset.zoom)}" target="_blank" rel="noopener" style="margin-top:8px">Open full size</a>`)));
}

const offerCard = (o, { showBusiness = true } = {}) => `
  <div class="offer ${o.audience === 'PERSONAL' || o.type === 'BIRTHDAY' ? 'personal' : ''}">
    ${o.attachment?.kind === 'image' ? offerMedia(o.attachment, o.title) : ''}
    ${showBusiness && o.business_name && !o.business_is_owner ? `<div class="tiny biz-tag">${o.business_logo_url ? `<img src="${esc(o.business_logo_url)}" alt="" />` : ''}${esc(o.business_name)}</div>` : ''}
    <div class="row between"><div class="title">${esc(o.title)}</div>${o.redeemable ? `<span class="badge green">${inr(o.value_paise)}</span>` : '<span class="badge gold">Auto</span>'}</div>
    ${o.redeemable ? `<div class="tiny" style="margin-top:2px">${o.points_cost_cp ? `<span class="badge gold">Uses ${esc(o.points_cost)} points</span>` : '<span class="badge blue">Free unlock · no points needed</span>'}</div>` : ''}
    ${o.description ? `<div class="small">${esc(o.description)}</div>` : ''}
    <div class="tiny muted" style="margin-top:4px">${esc(o.conditions)}${o.conditions ? ' · ' : ''}Valid till ${dateOnly(o.valid_to)}${o.coupon_code ? ` · Code <b>${esc(o.coupon_code)}</b>` : ''}</div>
    ${o.terms ? `<details class="tiny muted" style="margin-top:4px"><summary>Terms &amp; conditions</summary>${esc(o.terms)}</details>` : ''}
    ${o.redeemable || o.attachment?.kind === 'pdf' ? `<div class="row" style="margin-top:8px;gap:.5rem">
      ${o.redeemable ? `<button class="btn-sm btn-primary" data-redeem-offer="${o.id}" ${o.points_cost_cp && state.home && o.points_cost_cp > state.home.customer.balance_cp ? 'disabled' : ''}>Redeem at ${o.business_is_owner || !o.business_name ? 'store' : esc(o.business_name)}</button>` : ''}
      ${o.attachment?.kind === 'pdf' ? offerMedia(o.attachment, o.title) : ''}</div>` : ''}
  </div>`;

function bindOfferButtons() {
  bindMedia();
  $$('[data-redeem-offer]').forEach((b) => (b.onclick = busy(b, () => startRedemption({ kind: 'OFFER', offerId: Number(b.dataset.redeemOffer) }))));
}

const VIEWS = {
  async home() {
    const [h, challenges] = await Promise.all([api.get('/me'), api.get('/me/challenges').catch(() => [])]);
    state.home = h;
    shell('');
    const c = h.customer;
    const s = h.savings;
    $('#main').innerHTML = `
      <div class="stack">
        <div class="muted">Hello${c.name ? `, <b style="color:var(--text)">${esc(c.name)}</b>` : ''} 👋</div>
        <div class="points-card">
          <div class="small" style="opacity:.85">Available points</div>
          <div class="big">${esc(c.balance)}</div>
          <div class="value">Worth ${inr(c.reward_value_paise)}</div>
          <div class="row" style="margin-top:14px">
            <button id="showQr" class="grow">Show my QR</button>
            <button id="redeem" class="btn-gold grow">Use my points</button>
          </div>
        </div>
        ${challenges.length ? `<div class="section-title"><h2>Challenges</h2></div><div class="stack">${challenges.map(challengeCard).join('')}</div>` : ''}
        <div class="card flat">
          <div class="row between"><h3 style="margin:0">My Savings</h3><span class="savings-total" style="font-size:1.2rem">${inr(s.total_paise)}</span></div>
          <div class="grid k2 small" style="margin-top:6px">
            <div><div class="muted">Points redeemed</div><b>${inr(s.points_paise)}</b></div>
            <div><div class="muted">Offer savings</div><b>${inr(s.offers_paise)}</b></div>
            <div><div class="muted">Coupons</div><b>${inr(s.coupons_paise)}</b></div>
          </div>
        </div>
        ${h.offers.forYou.length ? `<div class="section-title"><h2>Offers for You</h2><a href="#" data-go="offers" class="small">See all</a></div>
          <div class="stack">${h.offers.forYou.slice(0, 3).map(offerCard).join('')}</div>` : ''}
        <div class="section-title"><h2>Offers for Everyone</h2><a href="#" data-go="offers" class="small">See all</a></div>
        <div class="stack">${h.offers.everyone.slice(0, 3).map(offerCard).join('') || '<div class="empty">No offers right now. Check back soon!</div>'}</div>
        <button class="btn-block" data-go="stores" style="justify-content:space-between">${ICON.map}<span class="grow" style="text-align:left">Our stores &amp; customer care</span><span>›</span></button>
      </div>`;
    $('#showQr').onclick = () => go('qr');
    $('#redeem').onclick = () => go('offers');
    $$('[data-go]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); go(a.dataset.go); }));
    bindOfferButtons();
  },

  /** Rewards Marketplace: coupons, then every business where points can be used. */
  async offers() {
    const [m, o] = await Promise.all([api.get('/me/marketplace'), api.get('/me/offers')]);
    state.market = m;
    const c = state.home.customer;
    const auto = [...o.forYou, ...o.everyone].filter((x) => !x.redeemable);
    $('#main').innerHTML = `
      <div class="points-card slim"><div class="row between"><div><div class="small" style="opacity:.85">Your points</div><div class="big" style="font-size:1.8rem">${esc(c.balance)}</div></div>
        <div class="right"><div class="small" style="opacity:.85">Worth</div><div class="value">${inr(c.reward_value_paise)}</div></div></div></div>
      ${m.coupons.length ? `<div class="section-title"><h2>My coupons &amp; unlocked rewards</h2></div><div class="stack">${m.coupons.map((x) => offerCard(x)).join('')}</div>` : ''}
      <div class="section-title"><h2>Use my points</h2></div>
      <div class="stack">${m.businesses.map((b) => `
        <button class="biz-tile" data-biz="${b.id}">
          ${bizLogo(b)}
          <div class="grow" style="text-align:left"><div class="title">${esc(b.name)}</div>
            <div class="small muted">${esc(b.tagline || b.category || '')}</div>
            <div class="tiny" style="margin-top:3px">${b.can_use_points ? `Up to <b>${inr(b.max_paise_now)}</b> of your points${b.rule.limit_type.includes('PERCENT') ? ` · max ${b.rule.max_percent}% of bill` : ''}` : `<span class="muted">${esc(b.reasons[0] || '')}</span>`}
              ${b.rewards.length ? ` · <b>${b.rewards.length}</b> reward${b.rewards.length > 1 ? 's' : ''}` : ''}</div></div>
          <span>›</span>
        </button>`).join('') || '<div class="empty">No businesses accept points right now.</div>'}</div>
      ${auto.length ? `<div class="section-title"><h2>Earn more points</h2></div><div class="stack">${auto.map((x) => offerCard(x)).join('')}</div>` : ''}
      <p class="tiny muted" style="margin-top:14px">Redeeming creates a one-time QR. Show it to the manager at that business <b>before billing</b>. "Auto" offers are credited automatically after your Vasantham purchase is processed.</p>`;
    $$('[data-biz]').forEach((b) => (b.onclick = () => { state.bizId = Number(b.dataset.biz); go('business'); }));
    bindOfferButtons();
  },

  async business() {
    const m = state.market || (state.market = await api.get('/me/marketplace'));
    const b = m.businesses.find((x) => x.id === state.bizId);
    if (!b) return go('offers');
    $('#main').innerHTML = `
      <button class="btn-ghost btn-sm" data-go="offers" style="padding-left:0">‹ All rewards</button>
      <div class="card stack">
        <div class="row" style="flex-wrap:nowrap">${bizLogo(b, 56)}<div><h2 style="margin:0">${esc(b.name)}</h2><div class="small muted">${esc(b.tagline || b.category || '')}</div></div></div>
        <div class="rules"><div class="small"><b>How points work here</b></div>
          <ul class="small">${b.rule.lines.map((l) => `<li>${esc(l)}</li>`).join('')}<li>1 point = ₹2</li></ul></div>
        <div class="row between"><div><div class="small muted">You can use up to</div><b style="font-size:1.2rem">${inr(b.max_paise_now)}</b> <span class="small muted">(${pts(b.max_cp_now)} points)</span></div>
          <button class="btn-gold" id="usePts" ${b.can_use_points ? '' : 'disabled'}>Redeem points here</button></div>
        ${b.reasons.length ? `<div class="small muted">${b.reasons.map(esc).join('<br/>')}</div>` : ''}
      </div>
      <div class="section-title"><h2>Rewards at ${esc(b.name)}</h2></div>
      <div class="stack">${b.rewards.map((x) => offerCard(x, { showBusiness: false })).join('') || '<div class="empty">No rewards here right now. You can still redeem points.</div>'}</div>
      ${b.terms ? `<details class="small muted" style="margin-top:14px"><summary>Terms &amp; conditions</summary><div style="white-space:pre-line">${esc(b.terms)}</div></details>` : ''}`;
    $$('[data-go]').forEach((a) => (a.onclick = () => go(a.dataset.go)));
    $('#usePts').onclick = () => redeemPointsDialog(state.home.customer, b);
    bindOfferButtons();
  },

  async qr() {
    const load = async () => {
      const q = await api.get('/me/qr');
      const box = $('#qrBox');
      if (!box) return;
      box.innerHTML = q.svg;
      $('#qrCode').textContent = q.code;
    };
    $('#main').innerHTML = `
      <div class="center stack">
        <h2>My Vasantham QR</h2>
        <p class="muted small">Show this at the counter or to the store manager to identify your account.</p>
        <div class="qr-box" id="qrBox"><div class="spinner"></div></div>
        <div>Member ID <b id="qrCode"></b></div>
        <p class="tiny muted">For your security this QR refreshes every minute. Screenshots stop working after a few minutes.</p>
        <p class="small">Or just tell the cashier your mobile number.</p>
      </div>`;
    await load();
    timers.push(setInterval(() => load().catch(() => {}), 60000));
  },

  async points() {
    const [h, ledger] = await Promise.all([api.get('/me'), api.get('/me/ledger')]);
    state.home = h;
    const c = h.customer;
    $('#main').innerHTML = `
      <div class="grid k2">
        <div class="kpi"><div class="label">Current balance</div><div class="value">${esc(c.balance)}</div><div class="sub">${inr(c.reward_value_paise)}</div></div>
        <div class="kpi"><div class="label">Points earned</div><div class="value">${esc(c.earned)}</div></div>
        <div class="kpi"><div class="label">Points redeemed</div><div class="value">${esc(c.redeemed)}</div></div>
        <div class="kpi"><div class="label">Reward value</div><div class="value">${inr(c.reward_value_paise)}</div><div class="sub">1 point = ₹2</div></div>
      </div>
      <div class="row between" style="margin:18px 0 6px"><h2 style="margin:0">Points history</h2><button class="btn-sm" data-go="redemptions">My redemptions</button></div>
      <div class="card flat">${ledger.map((l) => `
        <div class="list-item">
          <div><div><b>${esc(LEDGER_LABEL[l.type] || l.type)}</b> <span class="muted small">${esc(l.branch || '')}</span></div>
            <div class="small muted">${esc(l.note || '')}</div><div class="tiny muted">${l.bill_date ? dateOnly(l.bill_date) : dt(l.created_at)}</div></div>
          <div class="${l.cp >= 0 ? 'pos' : 'neg'} num">${l.cp >= 0 ? '+' : ''}${pts(l.cp)}</div>
        </div>`).join('') || '<div class="empty">No points activity yet. Shop at any Vasantham store and give your mobile number at billing.</div>'}</div>`;
    $$('[data-go]').forEach((a) => (a.onclick = () => go(a.dataset.go)));
  },

  async more() {
    const h = state.home || (await api.get('/me'));
    const c = h.customer;
    $('#main').innerHTML = `
      <div class="card stack">
        <div><div class="muted small">Member ID</div><b>${esc(c.code)}</b></div>
        <div><div class="muted small">Mobile</div><b>${esc(c.mobile)}</b></div>
      </div>
      <div class="card stack" style="margin-top:12px">
        ${[['refer', 'Refer a friend'], ['stores', 'Stores & customer care'], ['purchases', 'Purchase history'], ['savings', 'My Savings'], ['redemptions', 'My redemptions'], ['notifications', 'Notifications'], ['profile', 'Edit profile']]
          .map(([k, l]) => `<button class="btn-block" data-go="${k}" style="justify-content:space-between">${l}<span>›</span></button>`).join('')}
      </div>
      <button class="btn-block btn-ghost" id="logout" style="margin-top:14px">Log out</button>`;
    $$('[data-go]').forEach((a) => (a.onclick = () => go(a.dataset.go)));
    $('#logout').onclick = () => { api.token = null; state.home = null; renderLogin(); };
  },

  async stores() {
    const { branches: bs, care } = await api.get('/me/stores');
    const c = state.home?.customer;
    const complaint = `Hello Vasantham, I am a Vasantham Rewards member${c ? ` (ID ${c.code}, mobile ${c.mobile})` : ''}. My complaint / query: `;
    const hasCare = care.care_phone || care.care_whatsapp || care.care_email;
    $('#main').innerHTML = `
      <h2>Our stores</h2>
      <div class="stack">${bs.map((b) => `
        <div class="card store">
          <div class="title">${b.owner ? `Vasantham ${esc(b.name)}` : `${esc(b.business)} <span class="muted small">· ${esc(b.name)}</span>`}</div>
          ${b.address ? `<div class="small muted addr">${esc(b.address)}</div>` : b.city ? `<div class="small muted">${esc(b.city)}</div>` : ''}
          ${b.phone ? `<a class="phone" href="${esc(telHref(b.phone))}">${ICON.call}${esc(b.phone)}</a>` : ''}
          <div class="contact-actions">
            ${b.phone ? contactBtn(telHref(b.phone), ICON.call, 'Call') : ''}
            ${b.whatsapp ? contactBtn(waHref(b.whatsapp), ICON.whatsapp, 'WhatsApp', 'wa') : ''}
            ${b.address || b.map_url ? contactBtn(mapHref(b), ICON.map, 'Directions') : ''}
          </div>
        </div>`).join('') || '<div class="empty">Store details will be available soon.</div>'}</div>
      <h2 style="margin-top:20px">Customer care</h2>
      <div class="card stack care">
        ${hasCare ? `
          <p class="small muted" style="margin:0">For complaints, feedback or help with your points, contact us${care.care_hours ? ` (${esc(care.care_hours)})` : ''}.</p>
          ${care.care_phone ? `<a class="phone" href="${esc(telHref(care.care_phone))}">${ICON.call}${esc(care.care_phone)}</a>` : ''}
          <div class="contact-actions">
            ${care.care_phone ? contactBtn(telHref(care.care_phone), ICON.call, 'Call customer care', 'btn-primary') : ''}
            ${care.care_whatsapp ? contactBtn(waHref(care.care_whatsapp, complaint), ICON.whatsapp, 'WhatsApp us', 'wa') : ''}
            ${care.care_email ? contactBtn(`mailto:${care.care_email}?subject=${encodeURIComponent('Vasantham Rewards – complaint / query')}&body=${encodeURIComponent(complaint)}`, ICON.mail, 'Email') : ''}
          </div>` : '<div class="small muted">Please contact any of our stores above.</div>'}
      </div>`;
  },

  async refer() {
    const r = await api.get('/me/referral');
    const link = `${location.origin}/customer?ref=${encodeURIComponent(r.code || '')}`;
    const p = r.program;
    const shareText = p ? `Join Vasantham Rewards with my code ${r.code} and get ${p.referee_reward} after your first purchase${p.min_purchase ? ` of ${p.min_purchase} or more` : ''}. ${link}` : '';
    const ST = { PENDING: ['warn', 'Waiting for first purchase'], REWARDED: ['green', 'Rewarded'], REJECTED: ['', 'Not eligible'], EXPIRED: ['', 'Expired'] };
    $('#main').innerHTML = `
      <h2>Refer a friend</h2>
      ${p ? `<div class="card stack">
          <div class="small">Invite friends to Vasantham Rewards. When they make their first Vasantham purchase${p.min_purchase ? ` of <b>${esc(p.min_purchase)}</b> or more` : ''} within ${p.qualify_days} days:</div>
          <div class="grid k2 small"><div class="rules"><b>You get</b><br/>${esc(p.referrer_reward)}</div><div class="rules"><b>Your friend gets</b><br/>${esc(p.referee_reward)}</div></div>
          <div class="center"><div class="small muted">Your referral code</div><div class="ref-code">${esc(r.code)}</div></div>
          <div class="contact-actions">
            <a class="btn btn-sm wa" href="https://wa.me/?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener">${ICON.whatsapp}Share on WhatsApp</a>
            <button class="btn-sm" id="copy">Copy link</button>
          </div>
          <div class="tiny muted">Up to ${p.max_referrals} friends. Your friend must be new to Vasantham and enter your code when they join. Offer ends ${dateOnly(p.valid_to)}.</div>
        </div>` : '<div class="empty card">There is no referral offer running right now.</div>'}
      ${r.can_apply.ok ? `<div class="card stack" style="margin-top:12px"><b>Joined because of a friend?</b>
          <div class="row"><input id="fcode" placeholder="Friend's code" value="${esc(pendingRef())}" style="flex:1;min-width:0" autocapitalize="characters" /><button class="btn-primary" id="apply">Apply</button></div></div>` : ''}
      ${r.applied ? `<div class="alert ${r.applied.status === 'REWARDED' ? 'ok' : 'info'} small" style="margin-top:12px">You joined with ${esc(r.applied.referrer_name || 'a friend')}'s code: ${esc((ST[r.applied.status] || [])[1] || r.applied.status)}.</div>` : ''}
      <h3 style="margin-top:16px">Your referrals</h3>
      <div class="card flat">${r.referrals.map((x) => `<div class="list-item"><div><b>${esc(x.friend)}</b><div class="tiny muted">${dateOnly(x.created_at)}</div></div>
        <span class="badge ${ST[x.status]?.[0] || ''}">${esc(ST[x.status]?.[1] || x.status)}</span></div>`).join('') || '<div class="empty">No referrals yet.</div>'}</div>`;
    $('#copy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { prompt('Copy this link:', link); }
    });
    const ap = $('#apply');
    if (ap) ap.onclick = busy(ap, async () => {
      await api.post('/me/referral', { code: $('#fcode').value });
      try { sessionStorage.removeItem('vl_ref'); } catch { /* ignore */ }
      toast('Code applied. Your welcome reward unlocks with your first Vasantham purchase.');
      VIEWS.refer();
    });
  },

  async purchases() {
    const rows = await api.get('/me/purchases');
    $('#main').innerHTML = `<h2>Purchase history</h2><div class="card flat">${rows.map((p) => `
      <div class="list-item click" data-bill="${p.id}" style="cursor:pointer">
        <div><b>${p.bill_type === 'SALE' ? inr(p.net_paise) : `${p.bill_type === 'RETURN' ? 'Return' : 'Cancelled'} ${inr(p.net_paise)}`}</b>
          <div class="small muted">${esc(p.branch)} · Bill ${esc(p.bill_no)}</div><div class="tiny muted">${dateOnly(p.bill_date)} ${esc(p.bill_time || '')}</div></div>
        <div class="right">${p.bill_type === 'SALE' ? `<div class="pos">+${pts(p.credited_cp)}</div>` : ''}${p.discount_paise ? `<div class="tiny muted">Saved ${inr(p.discount_paise)}</div>` : ''}</div>
      </div>`).join('') || '<div class="empty">No purchases yet.</div>'}</div>
      <p class="tiny muted">Purchases appear here after the store's daily update.</p>`;
    $$('[data-bill]').forEach((el) => (el.onclick = async () => {
      const b = await api.get(`/me/purchases/${el.dataset.bill}`);
      modal(`
        <div class="row between"><h2>Bill ${esc(b.bill_no)}</h2><button data-close class="btn-sm">Close</button></div>
        <div class="small muted">${esc(b.branch)} · ${dateOnly(b.bill_date)} ${esc(b.bill_time || '')}</div>
        ${b.items.length ? `<table style="margin-top:10px"><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr>
          ${b.items.map((i) => `<tr><td>${esc(i.product_name || i.product_code)}<div class="tiny muted">${esc(i.category || '')}</div></td><td class="num">${i.qty ?? ''}</td><td class="num">${i.amount_paise != null ? inr(i.amount_paise) : ''}</td></tr>`).join('')}</table>` : '<p class="small muted">Item details are not available for this bill.</p>'}
        <table style="margin-top:10px">
          <tr><td>Bill value</td><td class="num">${inr(b.bill_value_paise)}</td></tr>
          <tr><td>Discount</td><td class="num">-${inr(b.discount_paise)}</td></tr>
          <tr><td><b>Paid</b></td><td class="num"><b>${inr(b.net_paise)}</b></td></tr>
          ${b.bill_type === 'SALE' ? `<tr><td>Points earned</td><td class="num pos">+${pts(b.credited_cp)}</td></tr>` : ''}
          ${b.reversed_cp ? `<tr><td>Points reversed (returns)</td><td class="num neg">-${pts(b.reversed_cp)}</td></tr>` : ''}
        </table>`);
    }));
  },

  async savings() {
    const h = (state.home = await api.get('/me'));
    const s = h.savings;
    $('#main').innerHTML = `
      <div class="card center stack">
        <div class="muted">Total savings with Vasantham Rewards</div>
        <div class="savings-total">${inr(s.total_paise)}</div>
      </div>
      <div class="card flat" style="margin-top:12px">
        <div class="list-item"><span>Points redeemed</span><b>${inr(s.points_paise)}</b></div>
        <div class="list-item"><span>Offer savings</span><b>${inr(s.offers_paise)}</b></div>
        <div class="list-item"><span>Coupons</span><b>${inr(s.coupons_paise)}</b></div>
        <div class="list-item"><b>Total savings</b><b>${inr(s.total_paise)}</b></div>
      </div>`;
  },

  async redemptions() {
    const rows = await api.get('/me/redemptions');
    $('#main').innerHTML = `<h2>My redemptions</h2><div class="card flat">${rows.map((r) => `
      <div class="list-item"><div>
        <b>${r.kind === 'POINTS' ? `${pts(r.cp)} points` : `${esc(r.offer_title)}${r.cp ? ` (${pts(r.cp)} pts)` : ''}`}</b> · ${inr(r.value_paise)}
        <div class="small muted">${esc(r.id)}${r.business ? ` · ${esc(r.business)}` : ''}${r.branch ? ` · ${esc(r.branch)}` : ''}</div>
        <div class="tiny muted">${dt(r.approved_at || r.created_at)}${r.cancel_reason ? ` · ${esc(r.cancel_reason)}` : ''}</div></div>
        <div>${statusBadge(r.status)}</div></div>`).join('') || '<div class="empty">No redemptions yet.</div>'}</div>`;
  },

  async notifications() {
    const rows = await api.get('/me/notifications');
    if (state.home) state.home.unread = 0;
    shell('');
    $('#main').innerHTML = `<h2>Notifications</h2><div class="card flat">${rows.map((n) => `
      <div class="list-item"><div class="grow"><b>${esc(n.title)}</b><div class="small">${esc(n.body || '')}</div>
        ${n.attachment ? `<div style="margin-top:6px">${offerMedia(n.attachment, n.title)}</div>` : ''}
        ${n.offer_id ? `<button class="btn-sm" data-go="offers" style="margin-top:6px">View offers ›</button>` : ''}
        <div class="tiny muted" style="margin-top:4px">${dt(n.created_at)}</div></div></div>`).join('') || '<div class="empty">No notifications.</div>'}</div>`;
    bindMedia();
    $$('[data-go]').forEach((a) => (a.onclick = () => go(a.dataset.go)));
  },

  async profile() {
    const h = (state.home = await api.get('/me'));
    const c = h.customer;
    $('#main').innerHTML = `
      <h2>Edit profile</h2>
      <div class="card stack">
        <div class="field"><label for="name">Name</label><input id="name" value="${esc(c.name || '')}" /></div>
        <div class="field"><label for="dob">Date of birth</label><input id="dob" type="date" max="${today()}" value="${esc(c.dob || '')}" ${c.dob ? 'disabled' : ''} /></div>
        <div class="field"><label for="ann">Wedding anniversary</label><input id="ann" type="date" max="${today()}" value="${esc(c.anniversary || '')}" ${c.anniversary ? 'disabled' : ''} /></div>
        <div class="tiny muted">Used for your birthday / anniversary rewards. Once saved, please contact the store to correct a date.</div>
        <button class="btn-primary" id="save">Save</button>
      </div>`;
    const b = $('#save');
    b.onclick = busy(b, async () => {
      await api.put('/me', { name: $('#name').value, dob: c.dob ? undefined : $('#dob').value || null, anniversary: c.anniversary ? undefined : $('#ann').value || null });
      toast('Profile saved');
      go('more');
    });
  },
};

/* ---------------- redemption ---------------- */
function redeemPointsDialog(c, b) {
  const maxCp = b.max_cp_now;
  const pctNote = b.rule.limit_type.includes('PERCENT') ? `The manager checks it against your bill: at ${esc(b.name)} points can pay up to ${b.rule.max_percent}% of the bill. Any extra points stay in your balance.` : '';
  const m = modal(`
    <div class="row between"><h2>Redeem at ${esc(b.name)}</h2><button data-close class="btn-sm">Close</button></div>
    <p class="small muted">Available: <b>${esc(c.balance)}</b> points (${inr(c.reward_value_paise)}) · usable here: <b>${pts(maxCp)}</b> (${inr(b.max_paise_now)})</p>
    ${b.rule.lines.length ? `<ul class="small" style="margin:0 0 8px;padding-left:18px">${b.rule.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    <div class="field"><label for="pts">Points to redeem</label><input id="pts" inputmode="decimal" placeholder="e.g. 50" /></div>
    <div class="chips" style="margin-bottom:10px">
      ${[25, 50, 100].filter((n) => n * 100 <= maxCp).map((n) => `<button data-p="${n}">${n}</button>`).join('')}
      <button data-p="${(maxCp / 100).toFixed(2)}">Max (${pts(maxCp)})</button>
    </div>
    <div class="alert ok" id="worth">Enter points to see the ₹ value</div>
    ${pctNote ? `<p class="tiny muted">${pctNote}</p>` : ''}
    <button class="btn-primary btn-block btn-lg" id="go" style="margin-top:12px">Generate redemption QR</button>
    <p class="tiny muted">Show the QR to the ${esc(b.name)} manager before billing. It works once and expires in 10 minutes.</p>`);
  const input = $('#pts', m.el);
  const upd = () => {
    const v = Number(input.value);
    $('#worth', m.el).textContent = v > 0 ? `${v.toFixed(2)} points = ₹${(Math.floor(v * 100) * 2 / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} off your bill` : 'Enter points to see the ₹ value';
  };
  input.oninput = upd;
  $$('[data-p]', m.el).forEach((b) => (b.onclick = () => { input.value = b.dataset.p; upd(); }));
  const g = $('#go', m.el);
  g.onclick = busy(g, async () => {
    m.close();
    await startRedemption({ kind: 'POINTS', points: input.value, businessId: b.id });
  });
  input.focus();
}

async function startRedemption(body) {
  const r = await api.post('/me/redemptions', body);
  let poll;
  const m = modal(`
    <div class="center stack">
      <h2>Show this to the ${r.business ? `${esc(r.business)} manager` : 'store manager'}</h2>
      <div class="qr-box">${r.svg}</div>
      <div><b>${r.kind === 'POINTS' ? `${esc(r.points)} points · ${inr(r.value_paise)}` : `Offer · ${inr(r.value_paise)}`}</b></div>
      <div class="small muted">Request ${esc(r.id)} · expires in <span class="countdown" id="cd"></span></div>
      <div id="rstatus" class="alert info">Waiting for manager approval…</div>
      <div class="row" style="justify-content:center"><button id="cancelReq" class="btn-sm">Cancel request</button><button data-close class="btn-sm">Close</button></div>
    </div>`, { onClose: () => clearInterval(poll) });
  const end = new Date(r.expires_at).getTime();
  const tick = () => {
    const s = Math.max(0, Math.round((end - Date.now()) / 1000));
    const el = $('#cd', m.el);
    if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  let n = 0;
  poll = setInterval(async () => {
    tick();
    if (++n % 3) return; // check status every 3 s
    try {
      const s = await api.get(`/me/redemptions/${encodeURIComponent(r.id)}/status`);
      const box = $('#rstatus', m.el);
      if (!box) return clearInterval(poll);
      if (s.status === 'CREATED') return;
      clearInterval(poll);
      $('.qr-box', m.el)?.remove();
      $('#cd', m.el)?.parentElement?.remove();
      if (['APPROVED', 'SUBMITTED'].includes(s.status)) {
        state.market = null;
        box.className = 'alert ok';
        box.innerHTML = `<b>Approved!</b> Collect the redemption slip from the manager and give it to the cashier. Ref <b>${esc(s.id)}</b>`;
        $('#cancelReq', m.el)?.remove();
        state.home = null;
      } else {
        box.className = 'alert warn';
        box.textContent = `Request ${s.status.toLowerCase()}${s.cancel_reason ? `: ${s.cancel_reason}` : ''}`;
      }
    } catch { /* keep polling */ }
  }, 1000);
  const cb = $('#cancelReq', m.el);
  cb.onclick = busy(cb, async () => {
    await api.post(`/me/redemptions/${encodeURIComponent(r.id)}/cancel`);
    toast('Request cancelled');
    m.close();
  });
}

/* ---------------- boot ---------------- */
if (api.token) go('home');
else renderLogin();
