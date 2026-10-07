import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG, DEFAULT_SETTINGS } from './config.js';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  phone TEXT,
  whatsapp TEXT,
  map_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- customer-facing contact details (customer care), free text
CREATE TABLE IF NOT EXISTS store_info (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','MANAGER')),
  branch_id INTEGER REFERENCES branches(id),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  mobile TEXT NOT NULL UNIQUE,
  name TEXT,
  dob TEXT,
  anniversary TEXT,
  pos_customer_code TEXT,
  home_branch_id INTEGER REFERENCES branches(id),
  enrolled_via TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  app_registered_at TEXT,
  balance_cp INTEGER NOT NULL DEFAULT 0,
  first_purchase_date TEXT,
  last_purchase_date TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED'))
);
CREATE INDEX IF NOT EXISTS ix_customers_pos ON customers(pos_customer_code);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES staff(id),
  uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL,
  rows_total INTEGER DEFAULT 0,
  bills_total INTEGER DEFAULT 0,
  bills_imported INTEGER DEFAULT 0,
  bills_duplicate INTEGER DEFAULT 0,
  bills_error INTEGER DEFAULT 0,
  items_imported INTEGER DEFAULT 0,
  new_customers INTEGER DEFAULT 0,
  points_credited_cp INTEGER DEFAULT 0,
  points_reversed_cp INTEGER DEFAULT 0,
  redemptions_reconciled INTEGER DEFAULT 0,
  recon_issues INTEGER DEFAULT 0,
  min_bill_date TEXT,
  max_bill_date TEXT,
  message TEXT
);

CREATE TABLE IF NOT EXISTS import_errors (
  id INTEGER PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  row_no INTEGER,
  bill_no TEXT,
  level TEXT NOT NULL DEFAULT 'ERROR',
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  bill_no TEXT NOT NULL,
  bill_date TEXT NOT NULL,
  bill_time TEXT,
  bill_type TEXT NOT NULL DEFAULT 'SALE' CHECK (bill_type IN ('SALE','RETURN','CANCELLED')),
  original_bill_no TEXT,
  original_purchase_id INTEGER REFERENCES purchases(id),
  customer_id INTEGER REFERENCES customers(id),
  mobile_raw TEXT,
  customer_code_raw TEXT,
  bill_value_paise INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  net_paise INTEGER NOT NULL,
  loyalty_discount_paise INTEGER,
  loyalty_ref TEXT,
  raw_points REAL NOT NULL DEFAULT 0,
  credited_cp INTEGER NOT NULL DEFAULT 0,
  reversed_cp INTEGER NOT NULL DEFAULT 0,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  created_at TEXT NOT NULL,
  UNIQUE (branch_id, bill_no, bill_date, bill_type)
);
CREATE INDEX IF NOT EXISTS ix_purchases_customer ON purchases(customer_id, bill_date);
CREATE INDEX IF NOT EXISTS ix_purchases_branch_date ON purchases(branch_id, bill_date);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  product_code TEXT,
  product_name TEXT,
  category TEXT,
  qty REAL,
  rate_paise INTEGER,
  discount_paise INTEGER,
  amount_paise INTEGER
);
CREATE INDEX IF NOT EXISTS ix_items_purchase ON purchase_items(purchase_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  segment TEXT NOT NULL,
  offer_id INTEGER,
  audience_size INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('GLOBAL','PERSONAL')),
  coupon_code TEXT,
  min_spend_paise INTEGER NOT NULL DEFAULT 0,
  value_paise INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  product TEXT,
  bonus_cp INTEGER NOT NULL DEFAULT 0,
  multiplier REAL,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  max_uses_per_customer INTEGER NOT NULL DEFAULT 1,
  branch_ids TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  campaign_id INTEGER REFERENCES campaigns(id),
  created_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offer_assignments (
  id INTEGER PRIMARY KEY,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  assigned_at TEXT NOT NULL,
  expires_on TEXT,
  UNIQUE (offer_id, customer_id)
);
CREATE INDEX IF NOT EXISTS ix_assign_customer ON offer_assignments(customer_id);

CREATE TABLE IF NOT EXISTS redemptions (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('POINTS','OFFER')),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  offer_id INTEGER REFERENCES offers(id),
  cp INTEGER NOT NULL DEFAULT 0,
  value_paise INTEGER NOT NULL,
  status TEXT NOT NULL,
  requested_via TEXT NOT NULL,
  verified_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  branch_id INTEGER REFERENCES branches(id),
  approved_by INTEGER REFERENCES staff(id),
  approved_at TEXT,
  submitted_at TEXT,
  billed_at TEXT,
  reconciled_at TEXT,
  purchase_id INTEGER REFERENCES purchases(id),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES staff(id),
  cancel_reason TEXT,
  recon_status TEXT
);
CREATE INDEX IF NOT EXISTS ix_redemptions_customer ON redemptions(customer_id, created_at);
CREATE INDEX IF NOT EXISTS ix_redemptions_branch ON redemptions(branch_id, approved_at);
CREATE INDEX IF NOT EXISTS ix_redemptions_status ON redemptions(status);

CREATE TABLE IF NOT EXISTS redemption_events (
  id INTEGER PRIMARY KEY,
  redemption_id TEXT NOT NULL REFERENCES redemptions(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  branch_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points_ledger (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL,
  cp INTEGER NOT NULL,
  balance_after_cp INTEGER NOT NULL,
  branch_id INTEGER REFERENCES branches(id),
  purchase_id INTEGER REFERENCES purchases(id),
  redemption_id TEXT REFERENCES redemptions(id),
  offer_id INTEGER REFERENCES offers(id),
  note TEXT,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ledger_customer ON points_ledger(customer_id, id);
CREATE INDEX IF NOT EXISTS ix_ledger_created ON points_ledger(created_at);

CREATE TABLE IF NOT EXISTS recon_issues (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  redemption_id TEXT,
  purchase_id INTEGER REFERENCES purchases(id),
  branch_id INTEGER REFERENCES branches(id),
  ref_text TEXT,
  expected_paise INTEGER,
  actual_paise INTEGER,
  detail TEXT,
  import_id INTEGER,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES staff(id),
  resolution_note TEXT
);

CREATE TABLE IF NOT EXISTS customer_segments (
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  segment TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, segment)
);
CREATE INDEX IF NOT EXISTS ix_segments_segment ON customer_segments(segment);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY,
  mobile TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_otps_mobile ON otps(mobile, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_notif_customer ON notifications(customer_id, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT,
  branch_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);

/* ---------- ecosystem: businesses / partners ---------- */
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  category TEXT,
  tagline TEXT,                                   -- one line shown in the Rewards Marketplace
  logo_file TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  can_earn INTEGER NOT NULL DEFAULT 0,            -- purchases here earn loyalty points
  can_redeem INTEGER NOT NULL DEFAULT 1,          -- loyalty points / rewards can be used here
  is_program_owner INTEGER NOT NULL DEFAULT 0,    -- runs the loyalty fund (Vasantham)
  billing_source TEXT NOT NULL DEFAULT 'MANAGER' CHECK (billing_source IN ('EXCEL','MANAGER')),
  offer_participation INTEGER NOT NULL DEFAULT 1, -- takes part in ecosystem offers / coupons
  settlement_cycle TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (settlement_cycle IN ('WEEKLY','MONTHLY','CUSTOM')),
  settlement_details TEXT,                        -- bank / UPI / ledger reference for payouts
  contact_person TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  address TEXT,
  terms TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES staff(id),
  updated_at TEXT
);

-- One current redemption policy per business, validated on the server before approval.
CREATE TABLE IF NOT EXISTS business_redemption_rules (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL UNIQUE REFERENCES businesses(id),
  limit_type TEXT NOT NULL DEFAULT 'NONE' CHECK (limit_type IN ('NONE','PERCENT','AMOUNT','PERCENT_AND_AMOUNT')),
  max_percent REAL,                  -- % of the bill that points may pay for
  max_value_paise INTEGER,           -- ₹ cap per redemption
  min_bill_paise INTEGER NOT NULL DEFAULT 0,
  min_points_cp INTEGER NOT NULL DEFAULT 0,
  branch_ids TEXT,                   -- eligible outlets (comma list); NULL = every outlet of the business
  updated_by INTEGER REFERENCES staff(id),
  updated_at TEXT NOT NULL
);

-- A settlement batches a business's settlement transactions for a period.
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  payable_paise INTEGER NOT NULL DEFAULT 0,      -- loyalty fund owes the business
  receivable_paise INTEGER NOT NULL DEFAULT 0,   -- business owes the loyalty fund
  txn_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SETTLED','VOID')),
  settled_paise INTEGER NOT NULL DEFAULT 0,
  settled_at TEXT,
  settled_by INTEGER REFERENCES staff(id),
  reference TEXT,
  note TEXT,
  created_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL
);

-- Money movements created by redemptions (append-only; reversals add negative rows).
CREATE TABLE IF NOT EXISTS settlement_transactions (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  redemption_id TEXT NOT NULL REFERENCES redemptions(id),
  direction TEXT NOT NULL CHECK (direction IN ('PAYABLE','RECEIVABLE')),
  kind TEXT NOT NULL CHECK (kind IN ('POINTS','REWARD','REVERSAL')),
  amount_paise INTEGER NOT NULL,
  note TEXT,
  settlement_id INTEGER REFERENCES settlements(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_settle_txn_business ON settlement_transactions(business_id, created_at);
CREATE INDEX IF NOT EXISTS ix_settle_txn_redemption ON settlement_transactions(redemption_id);

/* ---------- engagement: challenges (spend milestones + visit challenges) ---------- */
CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('SPEND','VISITS')),       -- SPEND = milestone, VISITS = visit-frequency challenge
  period TEXT NOT NULL CHECK (period IN ('MONTHLY','WEEKLY','CAMPAIGN')),
  business_id INTEGER NOT NULL REFERENCES businesses(id),     -- whose purchases count (must earn points)
  min_bill_paise INTEGER NOT NULL DEFAULT 0,                  -- VISITS: minimum bill for a visit to count
  segment TEXT,                                               -- eligible customers; NULL = everyone
  branch_ids TEXT,                                            -- participating branches; NULL = all
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  repeatable INTEGER NOT NULL DEFAULT 1,                      -- 1 = rewards can be earned again every period
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES staff(id),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS challenge_tiers (
  id INTEGER PRIMARY KEY,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id),
  threshold INTEGER NOT NULL,                                 -- paise (SPEND) or number of visits (VISITS)
  reward_type TEXT NOT NULL CHECK (reward_type IN ('POINTS','OFFER')),
  reward_cp INTEGER NOT NULL DEFAULT 0,
  reward_offer_id INTEGER REFERENCES offers(id),
  reward_valid_days INTEGER NOT NULL DEFAULT 30,
  UNIQUE (challenge_id, threshold)
);
CREATE TABLE IF NOT EXISTS customer_challenge_progress (
  challenge_id INTEGER NOT NULL REFERENCES challenges(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  period_key TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (challenge_id, customer_id, period_key)
);
CREATE TABLE IF NOT EXISTS challenge_awards (
  id INTEGER PRIMARY KEY,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id),
  tier_id INTEGER NOT NULL REFERENCES challenge_tiers(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  period_key TEXT NOT NULL,
  reward_type TEXT NOT NULL,
  reward_cp INTEGER NOT NULL DEFAULT 0,
  offer_id INTEGER REFERENCES offers(id),
  awarded_at TEXT NOT NULL,
  UNIQUE (tier_id, customer_id, period_key)
);

/* ---------- engagement: reactivation automations ---------- */
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  segment TEXT NOT NULL,                                      -- who is targeted (e.g. DORMANT, OVERDUE)
  offer_id INTEGER NOT NULL REFERENCES offers(id),            -- personalised reward at any business
  reward_valid_days INTEGER NOT NULL DEFAULT 14,
  cooldown_days INTEGER NOT NULL DEFAULT 60,                  -- don't target the same customer again within
  window_days INTEGER NOT NULL DEFAULT 30,                    -- a purchase within this many days = recovered
  message TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS automation_targets (
  id INTEGER PRIMARY KEY,
  automation_id INTEGER NOT NULL REFERENCES automations(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  target_date TEXT NOT NULL,
  targeted_at TEXT NOT NULL,
  UNIQUE (automation_id, customer_id, target_date)
);
CREATE INDEX IF NOT EXISTS ix_auto_targets_customer ON automation_targets(customer_id, target_date);

/* ---------- engagement: referrals ---------- */
CREATE TABLE IF NOT EXISTS referral_programs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  min_purchase_paise INTEGER NOT NULL DEFAULT 0,             -- referee's first qualifying Vasantham bill
  qualify_days INTEGER NOT NULL DEFAULT 30,                  -- referee must qualify within N days of joining
  referrer_reward_type TEXT NOT NULL CHECK (referrer_reward_type IN ('POINTS','OFFER')),
  referrer_cp INTEGER NOT NULL DEFAULT 0,
  referrer_offer_id INTEGER REFERENCES offers(id),
  referee_reward_type TEXT NOT NULL CHECK (referee_reward_type IN ('POINTS','OFFER')),
  referee_cp INTEGER NOT NULL DEFAULT 0,
  referee_offer_id INTEGER REFERENCES offers(id),
  reward_valid_days INTEGER NOT NULL DEFAULT 30,
  max_referrals INTEGER NOT NULL DEFAULT 10,                 -- per referrer
  max_per_day INTEGER NOT NULL DEFAULT 3,                    -- per referrer, fraud control
  new_customer_days INTEGER NOT NULL DEFAULT 30,             -- referee account must be this new, with no purchases
  created_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES staff(id),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES referral_programs(id),
  referrer_id INTEGER NOT NULL REFERENCES customers(id),
  referee_id INTEGER NOT NULL UNIQUE REFERENCES customers(id), -- a customer can be referred only once, ever
  code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','REWARDED','REJECTED','EXPIRED')),
  reason TEXT,
  created_at TEXT NOT NULL,
  qualified_at TEXT,
  purchase_id INTEGER REFERENCES purchases(id),
  resolved_by INTEGER REFERENCES staff(id)
);
CREATE INDEX IF NOT EXISTS ix_referrals_referrer ON referrals(referrer_id, created_at);

/* ---------- analytics: each customer's relationship with each business (rebuilt from purchases + redemptions) ---------- */
CREATE TABLE IF NOT EXISTS customer_business_activity (
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  first_activity_date TEXT NOT NULL,
  last_activity_date TEXT NOT NULL,
  first_via TEXT NOT NULL,                                   -- PURCHASE | REDEMPTION: how the customer first came to this business
  purchases INTEGER NOT NULL DEFAULT 0,
  spend_paise INTEGER NOT NULL DEFAULT 0,
  redemptions INTEGER NOT NULL DEFAULT 0,
  redemption_value_paise INTEGER NOT NULL DEFAULT 0,
  first_redemption_date TEXT,
  last_redemption_date TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, business_id)
);
CREATE INDEX IF NOT EXISTS ix_cba_business ON customer_business_activity(business_id, first_activity_date);

/* ---------- targeting: admin-defined interest segments ---------- */
CREATE TABLE IF NOT EXISTS interest_segments (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,                  -- segment key is INT:<code>
  name TEXT NOT NULL,
  categories TEXT,                                           -- comma list, matched case-insensitively
  keywords TEXT,                                             -- comma list, matched in product names
  min_share REAL NOT NULL DEFAULT 0.15,                      -- share of the customer's spend
  min_spend_paise INTEGER NOT NULL DEFAULT 0,
  lookback_days INTEGER NOT NULL DEFAULT 90,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
`;

fs.mkdirSync(CONFIG.dataDir, { recursive: true });
const file = CONFIG.dbFile === ':memory:' ? ':memory:' : path.join(CONFIG.dataDir, CONFIG.dbFile);
export const db = new DatabaseSync(file);
if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec(SCHEMA);

// migrations for databases created before a column existed
function addColumns(table, cols) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const [name, type] of Object.entries(cols)) if (!have.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
addColumns('customers', { anniversary: 'TEXT' });
addColumns('branches', { address: 'TEXT', phone: 'TEXT', whatsapp: 'TEXT', map_url: 'TEXT', business_id: 'INTEGER REFERENCES businesses(id)' });
addColumns('offers', {
  attachment_file: 'TEXT', attachment_type: 'TEXT', attachment_name: 'TEXT',
  business_id: 'INTEGER REFERENCES businesses(id)', // where the reward is used
  points_cost_cp: 'INTEGER NOT NULL DEFAULT 0', // >0 = points redemption reward (costs points); 0 = promotional unlock
  cost_paise: 'INTEGER', // internal cost of the reward (NULL = same as value)
  funding_type: "TEXT NOT NULL DEFAULT 'PROGRAM'", // PROGRAM (loyalty fund) | PARTNER | SHARED
  funder_business_id: 'INTEGER REFERENCES businesses(id)', // partner who funds PARTNER / SHARED rewards
  partner_share_paise: 'INTEGER NOT NULL DEFAULT 0', // SHARED: the partner's part of the cost
  terms: 'TEXT',
});
addColumns('imports', { calc_mode: "TEXT NOT NULL DEFAULT 'AMOUNT'" });
addColumns('notifications', { offer_id: 'INTEGER' });
addColumns('offer_assignments', {
  uses_allowed: 'INTEGER', // NULL = the offer's max uses; set when a reward is granted (once per grant)
  source: 'TEXT', // CAMPAIGN | ASSIGN | CHALLENGE | AUTOMATION | REFERRAL
});
addColumns('offers', { target_segments: 'TEXT' });
// role-based access: access_role = what the login may do; business_id = the business a scoped role is limited to
addColumns('staff', { access_role: 'TEXT', business_id: 'INTEGER REFERENCES businesses(id)' });
db.exec("UPDATE staff SET access_role = CASE role WHEN 'ADMIN' THEN 'SUPER_ADMIN' ELSE 'BRANCH_MANAGER' END WHERE access_role IS NULL"); // global offer shown only to these segments (comma list)
addColumns('customers', { referral_code: 'TEXT' });
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_referral_code ON customers(referral_code)');
addColumns('redemptions', {
  business_id: 'INTEGER REFERENCES businesses(id)',
  bill_paise: 'INTEGER', // bill amount entered at approval (for % / minimum bill rules)
  reward_cost_paise: 'INTEGER NOT NULL DEFAULT 0',
  program_funded_paise: 'INTEGER NOT NULL DEFAULT 0',
  partner_funded_paise: 'INTEGER NOT NULL DEFAULT 0',
  partner_bill_no: 'TEXT', // bill confirmed by a partner outlet (no Excel upload)
});

// Every database has a program owner business (the loyalty fund). Existing data belongs to it.
if (!db.prepare('SELECT 1 FROM businesses WHERE is_program_owner = 1').get()) {
  const now = new Date().toISOString();
  const id = db.prepare(
    `INSERT INTO businesses(code, name, category, tagline, can_earn, can_redeem, is_program_owner, billing_source, sort_order, created_at)
     VALUES ('VSM', 'Vasantham Super Mart', 'Supermarket', 'Redeem points on grocery purchases', 1, 1, 1, 'EXCEL', 1, ?)`,
  ).run(now).lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO business_redemption_rules(business_id, updated_at) VALUES (?, ?)').run(id, now);
}
db.exec(`
  UPDATE branches SET business_id = (SELECT id FROM businesses WHERE is_program_owner = 1 ORDER BY id LIMIT 1) WHERE business_id IS NULL;
  UPDATE offers SET business_id = (SELECT id FROM businesses WHERE is_program_owner = 1 ORDER BY id LIMIT 1) WHERE business_id IS NULL;
  UPDATE redemptions SET business_id = COALESCE((SELECT business_id FROM branches WHERE id = redemptions.branch_id),
    (SELECT id FROM businesses WHERE is_program_owner = 1 ORDER BY id LIMIT 1)) WHERE business_id IS NULL;
  CREATE TRIGGER IF NOT EXISTS trg_branch_business AFTER INSERT ON branches WHEN NEW.business_id IS NULL BEGIN
    UPDATE branches SET business_id = (SELECT id FROM businesses WHERE is_program_owner = 1 ORDER BY id LIMIT 1) WHERE id = NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS trg_offer_business AFTER INSERT ON offers WHEN NEW.business_id IS NULL BEGIN
    UPDATE offers SET business_id = (SELECT id FROM businesses WHERE is_program_owner = 1 ORDER BY id LIMIT 1) WHERE id = NEW.id;
  END;
  CREATE INDEX IF NOT EXISTS ix_redemptions_business ON redemptions(business_id, approved_at);
`);

const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, String(v));

/* ---------- helpers ---------- */

const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}
export const get = (sql, ...p) => stmt(sql).get(...p);
export const all = (sql, ...p) => stmt(sql).all(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);

let depth = 0;
/** Run fn atomically. Nested calls become savepoints. */
export function tx(fn) {
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const r = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export function setting(key) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? Number(r.value) : Number(DEFAULT_SETTINGS[key]);
}
export function allSettings() {
  return Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, Number(r.value)]));
}

export function nextCounter(key, start = 1) {
  const r = get('SELECT value FROM counters WHERE key = ?', key);
  const v = r ? r.value + 1 : start;
  run('INSERT INTO counters(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, v);
  return v;
}
