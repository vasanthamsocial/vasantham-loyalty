// Small shared client helpers for the three interfaces.
export function makeApi(storageKey) {
  const api = {
    get token() {
      try { return localStorage.getItem(storageKey); } catch { return null; }
    },
    set token(v) {
      try { v ? localStorage.setItem(storageKey, v) : localStorage.removeItem(storageKey); } catch { /* private mode */ }
    },
    onUnauthorized: () => {},
    async call(method, url, body, opts = {}) {
      const headers = {};
      if (api.token) headers.Authorization = `Bearer ${api.token}`;
      let payload;
      if (opts.raw) {
        headers['Content-Type'] = 'application/octet-stream';
        payload = opts.raw;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      let res;
      try {
        res = await fetch(`/api${url}`, { method, headers, body: payload });
      } catch {
        throw new Error('Network error — check your connection');
      }
      if (opts.blob) return res.blob();
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        api.token = null;
        api.onUnauthorized();
      }
      if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
      return data;
    },
    get: (u) => api.call('GET', u),
    post: (u, b = {}) => api.call('POST', u, b),
    put: (u, b = {}) => api.call('PUT', u, b),
  };
  return api;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function pts(cp) {
  const n = Number(cp || 0);
  const a = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.floor(a / 100).toLocaleString('en-IN')}.${String(a % 100).padStart(2, '0')}`;
}
export function inr(paise, { decimals = 'auto' } = {}) {
  const n = Number(paise || 0) / 100;
  const hasFrac = Math.round(Math.abs(n) * 100) % 100 !== 0;
  const d = decimals === 'auto' ? (hasFrac ? 2 : 0) : decimals;
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
export const pct = (x, d = 1) => `${(Number(x || 0) * 100).toFixed(d)}%`;
export const num = (x) => Number(x || 0).toLocaleString('en-IN');

const IST = 330 * 60000;
export function dt(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + IST);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${fmtTime(d.getUTCHours(), d.getUTCMinutes())}`;
}
export function timeOnly(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + IST);
  return fmtTime(d.getUTCHours(), d.getUTCMinutes());
}
export function dateOnly(s) {
  if (!s) return '';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtTime(h, m) {
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
export const todayIST = () => new Date(Date.now() + IST).toISOString().slice(0, 10);

let toastTimer;
export function toast(msg, isError = false) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 3000);
}

export function modal(html, { wide = false, onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  back.addEventListener('click', (e) => e.target === back && close());
  back.addEventListener('click', (e) => e.target.closest('[data-close]') && close());
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  return { el: back.firstElementChild, close };
}

/** Wrap an async click handler: disables the button while running, toasts errors. */
export function busy(btn, fn) {
  return async (...args) => {
    if (btn) btn.disabled = true;
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

export const STATUS_BADGE = {
  CREATED: 'blue', APPROVED: 'gold', SUBMITTED: 'gold', BILLED: 'warn', RECONCILED: 'green',
  CANCELLED: '', EXPIRED: '', REVERSED: 'red',
};
export const statusBadge = (s) => `<span class="badge ${STATUS_BADGE[s] ?? ''}">${esc(s === 'SUBMITTED' ? 'SUBMITTED TO BILLING' : s)}</span>`;

export const LEDGER_LABEL = {
  EARN: 'Purchase', BONUS: 'Bonus', REDEEM: 'Redemption', REDEEM_REVERSAL: 'Redemption reversed',
  RETURN_REVERSAL: 'Return / cancellation', ADJUST: 'Adjustment',
};
