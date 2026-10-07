// Copies the local database (data/vasantham.db) and uploaded files into a Turso database,
// so moving to Vercel keeps every customer, point, bill, redemption and setting.
//
//   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... npm run db:copy-to-turso
//
// The Turso database must be new (no customers yet). Add --force to replace what is there.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

if (!process.env.TURSO_DATABASE_URL) {
  console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to the target Turso database first.');
  process.exit(1);
}
const { CONFIG } = await import('../src/config.js');
const sourceFile = path.join(CONFIG.dataDir, CONFIG.dbFile);
if (!fs.existsSync(sourceFile)) {
  console.error(`Local database not found: ${sourceFile}`);
  process.exit(1);
}
const source = new DatabaseSync(sourceFile, { readOnly: true });

// Opening db.js with TURSO_DATABASE_URL set creates the schema on Turso.
const { all, db, get, insertRows, tx } = await import('../src/db.js');
const force = process.argv.includes('--force');
if (get('SELECT COUNT(*) n FROM customers').n > 0 && !force) {
  console.error('The Turso database already has customers. Nothing copied. Use --force to replace its data.');
  process.exit(1);
}

const tables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().map((t) => t.name);
const targetCols = (t) => all(`PRAGMA table_info(${t})`).map((c) => c.name);
const summary = [];

tx(() => {
  db.exec('PRAGMA defer_foreign_keys = ON'); // rows are checked together at commit
  for (const t of tables) {
    const have = targetCols(t);
    if (!have.length) {
      summary.push([t, 'skipped (not in target)']);
      continue;
    }
    const cols = source.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).filter((c) => have.includes(c));
    const rows = source.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t}"`).all().map((r) => cols.map((c) => r[c]));
    db.exec(`DELETE FROM "${t}"`);
    if (rows.length) insertRows(`"${t}"`, cols.map((c) => `"${c}"`), rows, { chunk: Math.max(1, Math.floor(4000 / cols.length)) });
    summary.push([t, rows.length]);
  }

  // uploaded offer images/PDFs and logos → media_files (Vercel serves them from the database)
  let files = 0;
  for (const [kind, sub] of [['offers', 'offers'], ['logos', 'logos']]) {
    const dir = path.join(CONFIG.dataDir, 'uploads', sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^[\w-]+\.(jpg|png|webp|pdf)$/.test(x))) {
      const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' }[f.split('.').pop()];
      db.prepare('INSERT OR REPLACE INTO media_files(kind, file, type, data, created_at) VALUES (?,?,?,?,?)')
        .run(kind, f, type, fs.readFileSync(path.join(dir, f)), new Date().toISOString());
      files++;
    }
  }
  summary.push(['uploaded files', files]);
});

for (const [t, n] of summary) console.log(`${String(t).padEnd(32)} ${n}`);
// verify: every table has the same number of rows on both sides
const mismatches = tables.filter((t) => targetCols(t).length && source.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n !== get(`SELECT COUNT(*) n FROM "${t}"`).n);
console.log(mismatches.length ? `Row counts differ for: ${mismatches.join(', ')}` : `Done: ${tables.length} tables copied and verified.`);
process.exit(mismatches.length ? 1 : 0);
