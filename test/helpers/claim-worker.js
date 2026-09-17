import { parentPort, workerData } from 'node:worker_threads';
import { Database } from '../../src/db.js';
import { DeliveryStore } from '../../src/store/delivery-store.js';

/**
 * Runs inside its own OS thread with its own SQLite connection to the SAME database file every
 * sibling thread points at — real cross-connection concurrency for `test/lease-concurrency.test.js`.
 * @type {{ path: string, now: number, leaseMs: number, batch: number, attempts: number }}
 */
const { path, now, leaseMs, batch, attempts } = workerData;

/** See scheduler's identical helper: absorbs a transient SQLITE_LOCKED from many threads opening their first connection to the same file at once. @returns {Database} */
function openWithRetry() {
  for (let attempt = 0; ; attempt++) {
    try {
      return new Database(path);
    } catch (err) {
      if (attempt >= 20 || !/locked|busy/i.test(/** @type {Error} */ (err).message)) throw err;
      const until = Date.now() + 10;
      while (Date.now() < until);
    }
  }
}

const db = openWithRetry();
const deliveries = new DeliveryStore(db);
/** @type {number[]} */
const claimed = [];
for (let i = 0; i < attempts; i++) {
  for (const r of deliveries.claim(now, batch, leaseMs)) claimed.push(r.id);
}
db.close();
parentPort?.postMessage({ claimed });
