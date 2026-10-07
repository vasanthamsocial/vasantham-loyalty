import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';

/*
 * Hosted SQLite (Turso / libSQL) with the same synchronous API as node:sqlite's DatabaseSync:
 * prepare(sql).get/all/run and exec(sql). The libSQL client is asynchronous, so it runs in a
 * worker thread and each call waits for its answer. That keeps every query, transaction and
 * savepoint in the app exactly as it is, and no request can interleave inside a transaction.
 */
const CALL_TIMEOUT_MS = 120_000;

// Blobs arrive from the worker as ArrayBuffer / Uint8Array; the app works with Buffers.
function toBuffers(rows) {
  for (const row of rows) {
    for (const k in row) {
      const v = row[k];
      if (v instanceof ArrayBuffer) row[k] = Buffer.from(v);
      else if (v instanceof Uint8Array) row[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    }
  }
  return rows;
}

export class RemoteDatabase {
  constructor(url, authToken) {
    this.flag = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(new URL('./db-remote-worker.js', import.meta.url), {
      workerData: { url, authToken, flag: this.flag, port: port2 },
      transferList: [port2],
    });
    this.worker.unref();
    this.port.unref();
    this.call({ op: 'ping' }); // fail fast with a clear error if the database can't be reached
    // close the connection before the process ends, so the worker never dies with it open
    const close = () => this.close();
    process.once('beforeExit', close);
    process.once('exit', close);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.call({ op: 'close' });
    } catch {
      /* already gone */
    }
  }

  call(msg) {
    if (this.closed && msg.op !== 'close') throw new Error('Database connection is closed');
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage(msg);
    if (Atomics.wait(this.flag, 0, 0, CALL_TIMEOUT_MS) === 'timed-out') throw new Error('Database did not respond in time');
    const reply = receiveMessageOnPort(this.port)?.message;
    if (!reply) throw new Error('Database connection lost');
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  }

  exec(sql) {
    this.call({ op: 'exec', sql });
  }

  prepare(sql) {
    return {
      get: (...args) => toBuffers(this.call({ op: 'query', sql, args }))[0],
      all: (...args) => toBuffers(this.call({ op: 'query', sql, args })),
      run: (...args) => this.call({ op: 'run', sql, args }),
    };
  }
}
