import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { LOGO_DIR, LOGO_URL, MEDIA_STORE, OFFER_MEDIA_DIR, OFFER_MEDIA_URL, readMedia } from './media.js';
import { get } from './db.js';
import authRoutes from './routes/auth.js';
import customerRoutes from './routes/customer.js';
import managerRoutes from './routes/manager.js';
import adminRoutes from './routes/admin.js';
import { expireStale } from './redemptions.js';
import { recomputeSegments } from './segments.js';
import { dailyEngagement } from './engagement.js';
import { istDate } from './util.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', process.env.VERCEL ? true : 'loopback'); // real client IPs behind Vercel's proxy
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/me', customerRoutes);
  app.use('/api/manager', managerRoutes);
  app.use('/api/admin', adminRoutes);
  app.get('/api/health', (req, res) => res.json({ ok: true, date: istDate() }));

  // Daily housekeeping for hosts without a long-running process (Vercel Cron calls this with CRON_SECRET).
  app.get('/api/cron/daily', (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(404).json({ error: 'Not found' });
    expireStale();
    const customers = recomputeSegments();
    dailyEngagement();
    res.json({ ok: true, customers, date: istDate() });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // offer images / PDFs (unguessable file names; served inline so phones open them in the viewer)
  if (MEDIA_STORE === 'db') {
    // files kept in the database (hosted setups such as Vercel)
    for (const [url, kind] of [[OFFER_MEDIA_URL, 'offers'], [LOGO_URL, 'logos']]) {
      app.get(`${url}/:file`, (req, res) => {
        const m = readMedia(kind, req.params.file);
        if (!m) return res.status(404).send('Not found');
        res.setHeader('Content-Type', m.type);
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        if (kind === 'offers') res.setHeader('Content-Disposition', 'inline');
        res.send(m.data);
      });
    }
  } else {
    app.use(OFFER_MEDIA_URL, express.static(OFFER_MEDIA_DIR, {
      index: false, dotfiles: 'deny', maxAge: '7d', immutable: true,
      setHeaders: (res) => res.setHeader('Content-Disposition', 'inline'),
    }));
    app.use(LOGO_URL, express.static(LOGO_DIR, { index: false, dotfiles: 'deny', maxAge: '7d', immutable: true }));
  }
  app.use(OFFER_MEDIA_URL, (req, res) => res.status(404).send('Not found'));
  app.use(LOGO_URL, (req, res) => res.status(404).send('Not found'));

  // each app is served from its own folder; URLs are unchanged
  const web = CONFIG.webDirs;
  for (const [url, dir] of Object.entries(web)) app.use(`/${url}`, express.static(dir, { extensions: ['html'] }));
  app.get('/', (req, res) => res.sendFile(path.join(web.shared, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message, ...(err.extra || {}) });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!get('SELECT 1 FROM staff LIMIT 1')) {
    console.log('No staff accounts yet — run "npm run seed" first to create branches and logins.');
  }
  const app = createApp();
  app.listen(CONFIG.port, () => {
    console.log(`Vasantham Loyalty running on http://localhost:${CONFIG.port}`);
    console.log(`  Customer app : http://localhost:${CONFIG.port}/customer`);
    console.log(`  Manager panel: http://localhost:${CONFIG.port}/manager`);
    console.log(`  Admin panel  : http://localhost:${CONFIG.port}/admin`);
  });
  // housekeeping: expire stale redemption tokens every minute; refresh segments nightly
  setInterval(expireStale, 60e3).unref();
  let lastSeg = istDate();
  setInterval(() => {
    if (istDate() !== lastSeg) {
      lastSeg = istDate();
      recomputeSegments();
      dailyEngagement(); // expire referrals, run reactivation automations
    }
  }, 10 * 60e3).unref();
}
