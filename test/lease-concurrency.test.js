import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Database } from '../src/db.js';
import { DeliveryStore } from '../src/store/delivery-store.js';
import { EventStore } from '../src/store/event-store.js';
import { SubscriptionStore } from '../src/store/subscription-store.js';

const CLAIM_WORKER = fileURLToPath(new URL('./helpers/claim-worker.js', import.meta.url));

/** @param {object} workerData */
function run(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(CLAIM_WORKER, { workerData });
    w.once('message', resolve);
    w.once('error', reject);
  });
}

// The single most important claim invariant, proven with REAL cross-connection concurrency (not
// same-process Promise.all): several OS threads, each with its own SQLite connection to the same
// file, racing to claim the same small set of due deliveries must never both succeed for one row.
test('Concurrency: several real connections racing for the same due deliveries never double-claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-claim-'));
  try {
    const path = join(dir, 'webhook-out.db');
    const db = new Database(path);
    const subscriptions = new SubscriptionStore(db);
    const events = new EventStore(db);
    const deliveries = new DeliveryStore(db);
    const now = Date.now();
    const sub = subscriptions.insert({ id: 'sub_1', name: 's', description: '', url: 'https://api.partner.example/x', events: '["*"]', headers: '{}', secret_enc: 'x', prev_secret_enc: null, prev_until: null, status: 'active', consecutive_failures: 0, last_delivery_at: null, last_status: null, created_by: 'test', created_at: now, updated_at: now, ordered: 0 });
    const event = events.insert({ id: 'evt_1', type: 'x', data: '{}', idem_key: null, source: 'test', only_subscription: null, created_at: now });
    const N = 12;
    for (let i = 0; i < N; i++) deliveries.insert({ eventId: event.id, subscriptionId: sub.id, maxAttempts: 3, nextAttemptAt: now }, now);
    db.close();

    const THREADS = 6;
    const results = await Promise.all(Array.from({ length: THREADS }, () => run({ path, now, leaseMs: 30_000, batch: 3, attempts: 4 })));
    const allClaimed = results.flatMap((r) => /** @type {{ claimed: number[] }} */ (r).claimed);
    assert.equal(allClaimed.length, N, 'every delivery claimed exactly once across all threads combined');
    assert.equal(new Set(allClaimed).size, N, 'no delivery id claimed twice');

    const verify = new Database(path);
    const check = new DeliveryStore(verify);
    assert.equal(check.stats(0).byStatus.running, N, 'every delivery moved to running exactly once');
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
