import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from '../src/db.js';
import { EventService } from '../src/domain/event-service.js';
import { SubscriptionService } from '../src/domain/subscription-service.js';
import { SecretBox } from '../src/crypto/secret-box.js';
import { HttpCaller } from '../src/net/http-caller.js';
import { NetGuard } from '@atc-web/service-core/http';
import { DeliveryStore } from '../src/store/delivery-store.js';
import { EventStore } from '../src/store/event-store.js';
import { HeartbeatStore } from '../src/store/heartbeat-store.js';
import { SubscriptionStore } from '../src/store/subscription-store.js';
import { Worker } from '../src/worker.js';
import { receiver, SECRETS_KEY, testConfig, testService } from './helpers.js';

const silent = /** @type {any} */ ({ info() {}, warn() {}, error() {}, fatal() {}, debug() {}, trace() {}, child() { return this; } });

/** One subscription + one queued delivery, ready to claim. */
function seedOne(/** @type {ReturnType<typeof testService>} */ t) {
  t.subscriptionService.create({ name: 's', url: 'https://api.partner.example/hook', events: ['*'] }, 'console');
  const { deliveries } = t.eventService.publish({ type: 'x', data: {} }, 'src');
  return deliveries[0];
}

test('DeliveryStore: claim hands out a fresh owner_token and lease_until per row', () => {
  const t = testService();
  t.subscriptionService.create({ name: 's1', url: 'https://api.partner.example/a', events: ['*'] }, 'console');
  t.subscriptionService.create({ name: 's2', url: 'https://api.partner.example/b', events: ['*'] }, 'console');
  t.eventService.publish({ type: 'x', data: {} }, 'src');
  const [d1, d2] = t.deliveries.claim(t.clock.now(), 2, 30_000);
  assert.ok(d1.owner_token && d2.owner_token && d1.owner_token !== d2.owner_token);
  assert.equal(d1.lease_until, t.clock.now() + 30_000);
});

test('DeliveryStore: finish is a no-op once the owner_token no longer matches (fencing)', () => {
  const t = testService();
  const d = seedOne(t);
  const [claimed] = t.deliveries.claim(t.clock.now(), 1, 30_000);
  const staleToken = /** @type {string} */ (claimed.owner_token);
  const finished = t.deliveries.finish(d.id, staleToken, { status: 'succeeded', finishedAt: t.clock.now(), durationMs: 5, httpStatus: 200, response: null, error: null, attempts: [], nextAttemptAt: null });
  assert.ok(finished);
  const late = t.deliveries.finish(d.id, staleToken, { status: 'failed', finishedAt: t.clock.now(), durationMs: 999, httpStatus: null, response: null, error: 'late', attempts: [], nextAttemptAt: null });
  assert.equal(late, null);
  assert.equal(t.deliveries.get(d.id)?.status, 'succeeded');
});

test('DeliveryStore: heartbeat renews lease_until only while the token still owns the row', () => {
  const t = testService();
  const d = seedOne(t);
  const [claimed] = t.deliveries.claim(t.clock.now(), 1, 30_000);
  const token = /** @type {string} */ (claimed.owner_token);
  t.clock.advance(10_000);
  assert.equal(t.deliveries.heartbeat(d.id, token, t.clock.now(), 30_000), true);
  assert.equal(t.deliveries.get(d.id)?.lease_until, t.clock.now() + 30_000);
  t.deliveries.finish(d.id, token, { status: 'succeeded', finishedAt: t.clock.now(), durationMs: 1, httpStatus: 200, response: null, error: null, attempts: [], nextAttemptAt: null });
  assert.equal(t.deliveries.heartbeat(d.id, token, t.clock.now(), 30_000), false);
});

test('DeliveryStore: reclaimExpired is atomic against a concurrent heartbeat for the same row', () => {
  const t = testService();
  const d = seedOne(t);
  t.deliveries.claim(t.clock.now(), 1, 10_000);
  t.clock.advance(20_000);
  const reclaimed = t.deliveries.reclaimExpired(t.clock.now(), (r) => ({ status: 'failed', finishedAt: t.clock.now(), durationMs: 0, httpStatus: null, response: null, error: 'lease expired', attempts: JSON.parse(r.attempts), nextAttemptAt: null }));
  assert.equal(reclaimed.length, 1);
  assert.equal(t.deliveries.get(d.id)?.status, 'failed');
});

test('DeliveryStore: reclaimExpired ignores a row whose lease was renewed before the sweep', () => {
  const t = testService();
  const d = seedOne(t);
  const [claimed] = t.deliveries.claim(t.clock.now(), 1, 10_000);
  const token = /** @type {string} */ (claimed.owner_token);
  t.clock.advance(9_000);
  assert.equal(t.deliveries.heartbeat(d.id, token, t.clock.now(), 10_000), true);
  t.clock.advance(9_000);
  const reclaimed = t.deliveries.reclaimExpired(t.clock.now(), (r) => ({ status: 'failed', finishedAt: t.clock.now(), durationMs: 0, httpStatus: null, response: null, error: 'lease expired', attempts: JSON.parse(r.attempts), nextAttemptAt: null }));
  assert.equal(reclaimed.length, 0);
  assert.equal(t.deliveries.get(d.id)?.status, 'running');
});

test('Worker: recover() only reclaims EXPIRED leases, not a lease still within its TTL', () => {
  const t = testService({ LEASE_MS: '5000', HEARTBEAT_MS: '1000' });
  const d = seedOne(t);
  t.deliveries.claim(t.clock.now(), 1, 5_000);
  t.worker.recover();
  assert.equal(t.deliveries.get(d.id)?.status, 'running');
  t.clock.advance(6_000);
  t.worker.recover();
  assert.equal(t.deliveries.get(d.id)?.status, 'retrying');
});

test('Worker: a late-returning owner cannot overwrite a delivery another worker already reclaimed', async (t) => {
  const rx = await receiver(() => ({ status: 200 }));
  t.after(rx.close);
  const svc = testService({ LEASE_MS: '5000', HEARTBEAT_MS: '1000' });
  svc.subscriptionService.create({ name: 's', url: `${rx.url}/x`, events: ['*'] }, 'console');
  const { deliveries: [d] } = svc.eventService.publish({ type: 'x', data: {} }, 'src');
  const [claimed] = svc.deliveries.claim(svc.clock.now(), 1, 5_000);
  const staleToken = /** @type {string} */ (claimed.owner_token);
  svc.clock.advance(6_000);
  const worker2 = new Worker({ events: svc.eventService, subscriptionService: svc.subscriptionService, subscriptions: svc.subscriptions, deliveries: svc.deliveries, eventStore: svc.events, presence: new HeartbeatStore(new Database(':memory:')), caller: new HttpCaller({ guard: new NetGuard({ allowHttp: true, allowPrivate: true, allowedHosts: [] }), timeoutMs: 5000 }), log: silent, options: { concurrency: 1, pollMs: 100, retentionDays: 30, disableAfterFailures: 10, leaseMs: 5_000, heartbeatMs: 1_000, drainMs: 5_000 }, now: svc.clock.now });
  worker2.recover();
  const afterReclaim = svc.deliveries.get(d.id);
  assert.equal(afterReclaim?.status, 'retrying');
  const late = svc.deliveries.finish(d.id, staleToken, { status: 'succeeded', finishedAt: svc.clock.now(), durationMs: 6_500, httpStatus: 200, response: '{}', error: null, attempts: [], nextAttemptAt: null });
  assert.equal(late, null, 'rejected: the stale token no longer owns this row');
  assert.equal(svc.deliveries.get(d.id)?.status, 'retrying');
});

test('Worker: heartbeat keeps a long in-flight call owned across the original lease window', async (t) => {
  const rx = await receiver(() => ({ status: 200, delayMs: 260 }));
  t.after(rx.close);
  const db = new Database(':memory:');
  const subscriptions = new SubscriptionStore(db);
  const events = new EventStore(db);
  const deliveries = new DeliveryStore(db);
  const presence = new HeartbeatStore(db);
  const guard = new NetGuard({ allowHttp: true, allowPrivate: true, allowedHosts: [] });
  const box = new SecretBox(Buffer.from(SECRETS_KEY, 'hex'));
  const config = testConfig();
  const subscriptionService = new SubscriptionService({ subscriptions, guard, box, options: config });
  const eventService = new EventService({ db, events, deliveries, subscriptions, options: config });
  const caller = new HttpCaller({ guard, timeoutMs: 2000 });
  const worker = new Worker({ events: eventService, subscriptionService, subscriptions, deliveries, eventStore: events, presence, caller, log: silent, options: { concurrency: 1, pollMs: 50, retentionDays: 30, disableAfterFailures: 10, leaseMs: 120, heartbeatMs: 40, drainMs: 5_000 } });
  subscriptionService.create({ name: 's', url: `${rx.url}/x`, events: ['*'] }, 'console');
  const { deliveries: [d] } = eventService.publish({ type: 'x', data: {} }, 'src');
  await worker.tick();
  const r = deliveries.get(d.id);
  assert.equal(r?.status, 'succeeded', r?.error ?? 'should have succeeded, not lost the lease to its own dead heartbeat');
  assert.equal(r?.attempt, 1);
});

test('DeliveryStore: reclaimExpired exact-boundary invariant — now == lease_until is NOT yet expired (Stage 6.1)', () => {
  const t = testService();
  const d = seedOne(t);
  const [claimed] = t.deliveries.claim(t.clock.now(), 1, 1_000);
  const leaseUntil = /** @type {number} */ (claimed.lease_until);
  const decide = (/** @type {any} */ r) => ({ status: /** @type {const} */ ('failed'), finishedAt: leaseUntil, durationMs: 0, httpStatus: null, response: null, error: 'lease expired', attempts: JSON.parse(r.attempts), nextAttemptAt: null });
  assert.deepEqual(t.deliveries.reclaimExpired(leaseUntil, decide), [], 'now === lease_until: still valid, same invariant as claim/heartbeat/finish');
  assert.equal(t.deliveries.get(d.id)?.status, 'running');
  const reclaimed = t.deliveries.reclaimExpired(leaseUntil + 1, decide);
  assert.equal(reclaimed.length, 1, 'one ms later: now expired');
});

test('Worker: stop() is bounded by drainMs even if an in-flight call never resolves (Stage 6.1)', async () => {
  const t = testService();
  t.subscriptionService.create({ name: 's', url: 'https://api.partner.example/x', events: ['*'] }, 'console');
  t.eventService.publish({ type: 'x', data: {} }, 'src');
  /** @type {[object, string][]} */
  const errors = [];
  const log = /** @type {any} */ ({
    info() {}, warn() {}, debug() {}, fatal() {}, child() { return this; },
    error(/** @type {object} */ obj, /** @type {string} */ msg) { errors.push([obj, msg]); },
  });
  const stuckCaller = { call: () => new Promise(() => {}) };
  const worker = new Worker({ events: t.eventService, subscriptionService: t.subscriptionService, subscriptions: t.subscriptions, deliveries: t.deliveries, eventStore: t.events, presence: new HeartbeatStore(new Database(':memory:')), caller: /** @type {any} */ (stuckCaller), log, options: { concurrency: 1, pollMs: 20, retentionDays: 30, disableAfterFailures: 10, leaseMs: 30_000, heartbeatMs: 1_000, drainMs: 100 }, now: t.clock.now });
  worker.start();
  const deadline = Date.now() + 2_000;
  while (t.deliveries.stats(0).byStatus.running === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  const startedStop = Date.now();
  await worker.stop();
  const elapsed = Date.now() - startedStop;
  assert.ok(elapsed < 1_000, `stop() must not hang forever; took ${elapsed}ms with drainMs=100`);
  assert.equal(errors.length, 1, 'logs exactly the drain-timeout error');
  assert.match(errors[0][1], /drain timed out/);
});
