// Worker thread for db-remote.js: runs the asynchronous libSQL client and answers one call at a time.
import { workerData } from 'node:worker_threads';

const { url, authToken, flag, port } = workerData;
// Hosted URLs (libsql://, https://) use the pure-JavaScript client: no native code, nothing to
// crash on shutdown, no platform binaries to deploy. Only local file: URLs (testing) need native.
const { createClient } = await import(url.startsWith('file:') ? '@libsql/client' : '@libsql/client/web');
const client = createClient({ url, authToken, intMode: 'number' });
let tx = null; // the open write transaction (BEGIN … COMMIT/ROLLBACK), if any

const rows = (rs) => rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])));

async function handle(m) {
  const target = tx || client;
  switch (m.op) {
    case 'close':
      if (tx) {
        try {
          await tx.rollback();
        } catch {
          /* ignore */
        }
        tx.close();
        tx = null;
      }
      client.close();
      return true;
    case 'ping':
      await client.execute('SELECT 1');
      return true;
    case 'exec': {
      const s = m.sql.trim().replace(/;$/, '').toUpperCase();
      if (s.startsWith('BEGIN')) {
        if (tx) throw new Error('Transaction already open');
        tx = await client.transaction('write');
        return null;
      }
      if (s === 'COMMIT' || s === 'ROLLBACK') {
        const t = tx;
        tx = null;
        if (t) {
          try {
            await (s === 'COMMIT' ? t.commit() : t.rollback());
          } finally {
            t.close();
          }
        }
        return null;
      }
      await target.executeMultiple(m.sql);
      return null;
    }
    case 'query':
      return rows(await target.execute({ sql: m.sql, args: m.args }));
    case 'run': {
      const rs = await target.execute({ sql: m.sql, args: m.args });
      return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? 0 : Number(rs.lastInsertRowid) };
    }
    default:
      throw new Error(`Unknown database operation ${m.op}`);
  }
}

port.on('message', async (m) => {
  let reply;
  try {
    reply = { result: await handle(m) };
  } catch (e) {
    reply = { error: { message: e.message, code: e.code } };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
