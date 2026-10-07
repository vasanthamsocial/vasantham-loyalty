// Packs the three app folders into one Firebase Hosting site with the same URLs as the local server:
//   /customer → customer-app/web   /manager → manager-panel   /admin → admin-panel   /shared, / → shared
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'firebase', 'hosting-dist');
const MAP = { customer: 'customer-app/web', manager: 'manager-panel', admin: 'admin-panel', shared: 'shared' };

fs.rmSync(out, { recursive: true, force: true });
for (const [url, dir] of Object.entries(MAP)) fs.cpSync(path.join(root, dir), path.join(out, url), { recursive: true });
fs.copyFileSync(path.join(root, 'shared', 'index.html'), path.join(out, 'index.html'));
const count = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).length;
console.log(`Hosting build: ${count(out)} files in firebase/hosting-dist`);
