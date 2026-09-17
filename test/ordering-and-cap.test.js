import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { Database } from '../src/db.js';
import { DeliveryStore } from '../src/store/delivery-store.js';
import { EventStore } from '../src/store/event-store.js';
import { SubscriptionStore } from '../src/store/subscription-store.js';
import { testService } from './helpers.js';

const CLAIM_WORKER = fileURLToPath(new URL('./helpers/claim-worker.js', import.meta.url));

/** @param {object} workerData */
function runClaimWorker(workerData) {
  return new Promise((resolve, reject) => {
    const w = new ThreadWorker(CLAIM_WORKER, { workerData });
    w.once('message', resolve);
    w.once('error', reject);
  });
}

// ---------------------------------------------------------------- ordered: single-process semantics

test('ordered subscription: claim() only ever returns the single earliest non-terminal delivery, never a later one', () => {
  const t = testService();
  const { row: sub } = t.subscriptionService.create({ name: 's', url: 'https://api.partner.example/x', events: ['*'], ordered: true }, 'console');
  assert.equal(sub.ordered, 1);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const { deliveries: [d] } = t.eventService.publish({ type: 'x', data: { i } }, 'src');
    ids.push(d.id);
  }
  // Plenty of free slots and a generous cap — only ordering, not capacity, should be limiting here.
  const claimed = t.deliveries.claim(t.clock.now(), 10, 30_000, 1_000_000);
  assert.deepEqual(claimed.map((d) => d.id), [ids[0]], 'only the earliest delivery is claimable, regardless of how many slots are free');
});

test('ordered subscription: N+1 is not claimable while N is retrying (even before N is due again), and becomes claimable once N reaches a terminal state', () => {
  const t = testService();
  const { row: sub } = t.subscriptionService.create({ name: 's', url: 'https://api.partner.example/x', events: ['*'], ordered: true }, 'console');
  const { deliveries: [d1] } = t.eventService.publish({ type: 'x', data: {} }, 'src');
  const { deliveries: [d2] } = t.eventService.publish({ type: 'x', data: {} }, 'src');

  const [c1] = t.deliveries.claim(t.clock.now(), 10, 30_000, 1_000_000);
  assert.equal(c1.id, d1.id);
  // d1 fails but is retryable, scheduled for well in the future — d2 IS due right now, but must
  // still not be claimable: N+1 must never overtake N while N awaits its own retry backoff.
  const future = t.clock.now() + 3_600_000;
  t.deliveries.finish(d1.id, /** @type {string} */ (c1.owner_token), { status: 'retrying', finishedAt: null, durationMs: 5, httpStatus: 503, response: null, error: 'unavailable', attempts: [], nextAttemptAt: future });
  assert.deepEqual(t.deliveries.claim(t.clock.now(), 10, 30_000, 1_000_000).map((d) => d.id), [], 'd2 is due, but d1 (retrying) still blocks it');

  // d1 finally reaches a terminal state (failed, retries exhausted) — only now is d2 claimable.
  t.clock.advance(3_600_000);
  const [c1again] = t.deliveries.claim(t.clock.now(), 10, 30_000, 1_000_000);
  assert.equal(c1again.id, d1.id, 'd1 itself becomes claimable again once its retry is due');
  t.deliveries.finish(d1.id, /** @type {string} */ (c1again.owner_token), { status: 'failed', finishedAt: t.clock.now(), durationMs: 5, httpStatus: 503, response: null, error: 'unavailable', attempts: [], nextAttemptAt: null });
  const [c2] = t.deliveries.claim(t.clock.now(), 10, 30_000, 1_000_000);
  assert.equal(c2.id, d2.id, 'd1 is terminal now — d2 is finally claimable');
  void sub;
});

test('ordered subscription: lease expiry + reclaim still fences correctly — N+1 does not proceed before N is terminal', () => {
  const t = testService();
  t.subscriptionService.create({ name: 's', url: 'https://api.partner.example/x', events: ['*'], ordered: true }, 'console');
  const { deliveries: [d1] } = t.eventService.publish({ type: 'x', data: {} }, 'src');
  const { deliveries: [d2] } = t.eventService.publish({ type: 'x', data: {} }, 'src');

  const [c1] = t.deliveries.claim(t.clock.now(), 10, 1_000, 1_000_000); // short lease
  assert.equal(c1.id, d1.id);
  // "Crash": no finish, no heartbeat. Lease expires.
  t.clock.advance(2_000);
  assert.deepEqual(t.deliveries.claim(t.clock.now(), 10, 1_000, 1_000_000).map((d) => d.id), [], 'still fenced: d1 is running (lease merely stale, not yet reclaimed) so d2 stays blocked');

  // Another worker's reclaim sweep runs (same mechanism Worker#reclaimStale uses).
  const reclaimed = t.deliveries.reclaimExpired(t.clock.now(), (d) => ({ status: 'retrying', finishedAt: null, durationMs: 0, httpStatus: null, response: null, error: 'lease expired', attempts: [], nextAttemptAt: t.clock.now() }));
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].id, d1.id);
  assert.equal(reclaimed[0].status, 'retrying');

  // d1 is due again (retrying, next_attempt_at = now) — it, not d2, is what claim() returns next.
  const [c1b] = t.deliveries.claim(t.clock.now(), 10, 1_000, 1_000_000);
  assert.equal(c1b.id, d1.id, 'reclaimed d1 is claimed again before d2 is ever considered');

  // The ORIGINAL owner_token (from before the reclaim) must no longer be able to finish the row —
  // Stage 6 fencing regression, unaffected by ordering.
  const staleFinish = t.deliveries.finish(d1.id, /** @type {string} */ (c1.owner_token), { status: 'succeeded', finishedAt: t.clock.now(), durationMs: 1, httpStatus: 200, response: null, error: null, attempts: [], nextAttemptAt: null });
  assert.equal(staleFinish, null, 'the stale, reclaimed-away owner_token can no longer write the row');

  // The NEW owner finishes d1 successfully — only now does d2 become claimable.
  t.deliveries.finish(d1.id, /** @type {string} */ (c1b.owner_token), { status: 'succeeded', finishedAt: t.clock.now(), durationMs: 1, httpStatus: 200, response: null, error: null, attempts: [], nextAttemptAt: null });
  const [c2] = t.deliveries.claim(t.clock.now(), 10, 1_000, 1_000_000);
  assert.equal(c2.id, d2.id);
});

// ---------------------------------------------------------------- unordered: per-subscription cap

test('unordered subscription: a single claim() call never exceeds the configured cap for that subscription, even with unlimited free slots', () => {
  const t = testService();
  t.subscriptionService.create({ name: 's', url: 'https://api.partner.example/x', events: ['*'] }, 'console'); // ordered defaults false
  for (let i = 0; i < 10; i++) t.eventService.publish({ type: 'x', data: { i } }, 'src');
  const CAP = 3;
  const claimed = t.deliveries.claim(t.clock.now(), 100, 30_000, CAP);
  assert.equal(claimed.length, CAP, 'capped even though 10 were due and 100 slots were free');
});

test('unordered subscription: already-running deliveries (from an earlier claim) count against the cap for a later claim() call', () => {
  const t = testService();
  t.subscriptionService.create({ name: 's', url: 'https://api.partner.example/x', events: ['*'] }, 'console');
  for (let i = 0; i < 10; i++) t.eventService.publish({ type: 'x', data: { i } }, 'src');
  const CAP = 3;
  const first = t.deliveries.claim(t.clock.now(), 100, 30_000, CAP);
  assert.equal(first.length, CAP);
  const second = t.deliveries.claim(t.clock.now(), 100, 30_000, CAP);
  assert.equal(second.length, 0, 'the cap is already fully spent by the still-running deliveries from the first claim');
  // Finish one — exactly one more slot should open up.
  t.deliveries.finish(first[0].id, /** @type {string} */ (first[0].owner_token), { status: 'succeeded', finishedAt: t.clock.now(), durationMs: 1, httpStatus: 200, response: null, error: null, attempts: [], nextAttemptAt: null });
  const third = t.deliveries.claim(t.clock.now(), 100, 30_000, CAP);
  assert.equal(third.length, 1);
});

test('unordered subscription: the cap is per-subscription — a noisy subscription never starves another subscription\'s deliveries', () => {
  const t = testService();
  t.subscriptionService.create({ name: 'noisy', url: 'https://api.partner.example/noisy', events: ['*'] }, 'console');
  t.subscriptionService.create({ name: 'quiet', url: 'https://api.partner.example/quiet', events: ['*'] }, 'console');
  for (let i = 0; i < 20; i++) t.eventService.publish({ type: 'x', data: { i } }, 'src'); // fans out to BOTH subscriptions
  const CAP = 2;
  const claimed = t.deliveries.claim(t.clock.now(), 100, 30_000, CAP);
  const bySub = new Map();
  for (const d of claimed) bySub.set(d.subscription_id, (bySub.get(d.subscription_id) ?? 0) + 1);
  assert.equal(bySub.size, 2, 'both subscriptions got some of their share');
  for (const n of bySub.values()) assert.equal(n, CAP, 'each subscription individually capped, not the total');
});

test('an ordered subscription\'s effective cap is 1 regardless of the configured subscriptionConcurrencyMax', () => {
  const t = testService();
  t.subscriptionService.create({ name: 's', url: 'https://api.partner.example/x', events: ['*'], ordered: true }, 'console');
  for (let i = 0; i < 10; i++) t.eventService.publish({ type: 'x', data: { i } }, 'src');
  const claimed = t.deliveries.claim(t.clock.now(), 100, 30_000, 1_000_000); // huge cap — irrelevant for ordered
  assert.equal(claimed.length, 1);
});

// ---------------------------------------------------------------- real cross-process concurrency

test('Concurrency (ordered): many real threads racing claim() on one ordered subscription with a large backlog never end up with more than one delivery running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-ordering-'));
  try {
    const path = join(dir, 'webhook-out.db');
    const db = new Database(path);
    const subscriptions = new SubscriptionStore(db);
    const events = new EventStore(db);
    const deliveries = new DeliveryStore(db);
    const now = Date.now();
    const sub = subscriptions.insert({ id: 'sub_1', name: 's', description: '', url: 'https://api.partner.example/x', events: '["*"]', headers: '{}', secret_enc: 'x', prev_secret_enc: null, prev_until: null, status: 'active', consecutive_failures: 0, last_delivery_at: null, last_status: null, created_by: 'test', created_at: now, updated_at: now, ordered: 1 });
    const event = events.insert({ id: 'evt_1', type: 'x', data: '{}', idem_key: null, source: 'test', only_subscription: null, created_at: now });
    const N = 20;
    for (let i = 0; i < N; i++) deliveries.insert({ eventId: event.id, subscriptionId: sub.id, maxAttempts: 3, nextAttemptAt: now }, now);
    db.close();

    const THREADS = 6;
    // Threads only ever claim, never finish — so whatever gets claimed stays 'running' forever,
    // giving a clean, static end state to assert against (no live mid-run snapshot needed).
    await Promise.all(Array.from({ length: THREADS }, () => runClaimWorker({ path, now, leaseMs: 30_000, batch: 5, attempts: 10, subscriptionConcurrencyMax: 1_000_000 })));

    const verify = new Database(path);
    const byStatus = new DeliveryStore(verify).stats(0).byStatus;
    assert.equal(byStatus.running, 1, 'exactly one delivery ever got claimed for the ordered subscription, no matter how many threads raced for it');
    assert.equal(byStatus.pending, N - 1);
    verify.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Concurrency (cap): many real threads racing claim() on one unordered subscription never exceed the configured cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-cap-'));
  try {
    const path = join(dir, 'webhook-out.db');
    const db = new Database(path);
    const subscriptions = new SubscriptionStore(db);
    const events = new EventStore(db);
    const deliveries = new DeliveryStore(db);
    const now = Date.now();
    const CAP = 4;
    const sub = subscriptions.insert({ id: 'sub_1', name: 's', description: '', url: 'https://api.partner.example/x', events: '["*"]', headers: '{}', secret_enc: 'x', prev_secret_enc: null, prev_until: null, status: 'active', consecutive_failures: 0, last_delivery_at: null, last_status: null, created_by: 'test', created_at: now, updated_at: now, ordered: 0 });
    const event = events.insert({ id: 'evt_1', type: 'x', data: '{}', idem_key: null, source: 'test', only_subscription: null, created_at: now });
    const N = 30;
    for (let i = 0; i < N; i++) deliveries.insert({ eventId: event.id, subscriptionId: sub.id, maxAttempts: 3, nextAttemptAt: now }, now);
    db.close();

    const THREADS = 8;
    await Promise.all(Array.from({ length: THREADS }, () => runClaimWorker({ path, now, leaseMs: 30_000, batch: 5, attempts: 10, subscriptionConcurrencyMax: CAP })));

    const verify = new Database(path);
    const byStatus = new DeliveryStore(verify).stats(0).byStatus;
    assert.equal(byStatus.running, CAP, `at most ${CAP} ever running, regardless of ${THREADS} threads racing far more attempts than that`);
    assert.equal(byStatus.pending, N - CAP);
    verify.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- regressions named in the brief

test('regression: idempotent concurrent publish (Stage 6) still falls back to the existing event, unaffected by ordering/cap; UNIQUE conflict never surfaces as a raw error', () => {
  const t = testService();
  t.subscriptionService.create({ name: 's', url: 'https://api.partner.example/x', events: ['*'], ordered: true }, 'console');
  const first = t.eventService.publish({ type: 'x', data: { a: 1 }, idempotencyKey: 'key-1' }, 'src');
  const second = t.eventService.publish({ type: 'x', data: { a: 2 }, idempotencyKey: 'key-1' }, 'src');
  assert.equal(second.duplicate, true);
  assert.equal(second.event.id, first.event.id);
  assert.equal(second.deliveries.length, first.deliveries.length);
});

test('regression: deleting a subscription still cascades its deliveries (ordered or not), no pending-work protection broken', () => {
  const t = testService();
  const { row: sub } = t.subscriptionService.create({ name: 's', url: 'https://api.partner.example/x', events: ['*'], ordered: true }, 'console');
  const { deliveries: [d] } = t.eventService.publish({ type: 'x', data: {} }, 'src');
  assert.ok(t.deliveries.get(d.id));
  t.subscriptionService.remove(sub.id);
  assert.equal(t.deliveries.get(d.id), undefined, 'delivery cascade-deleted along with its subscription');
});
