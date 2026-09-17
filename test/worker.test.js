import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Signer } from '../src/net/signer.js';
import { receiver, testService } from './helpers.js';

const iso = (/** @type {number|null} */ t) => (t === null ? null : new Date(t).toISOString());

test('Worker: delivery carries signature, ids, custom headers and the event body', async (t) => {
  const rx = await receiver(() => ({ status: 200, body: '{"received":true}' }));
  t.after(rx.close);
  const { subscriptionService: s, eventService: ev, worker, deliveries, subscriptions, clock } = testService();
  const { row: sub, secret } = s.create({ name: 'a', url: `${rx.url}/hooks`, events: ['order.*'], headers: { 'X-Tenant': 'shop-1' } }, 'console');
  const { event, deliveries: [d] } = ev.publish({ type: 'order.paid', data: { orderId: 42, total: 199.9 } }, 'shop-backend');
  await worker.tick();
  const done = /** @type {import('../src/types.js').DeliveryRow} */ (deliveries.get(d.id));
  assert.equal(done.status, 'succeeded', done.error ?? '');
  assert.deepEqual([done.http_status, done.response, done.attempt, JSON.parse(done.attempts).length], [200, '{"received":true}', 1, 1]);
  const after = /** @type {import('../src/types.js').SubscriptionRow} */ (subscriptions.get(sub.id));
  assert.deepEqual([after.last_status, after.consecutive_failures, iso(after.last_delivery_at)], ['succeeded', 0, iso(clock.now())]);
  const [req] = rx.received;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/hooks');
  assert.deepEqual(JSON.parse(req.body), { id: event.id, type: 'order.paid', createdAt: iso(event.created_at), data: { orderId: 42, total: 199.9 } });
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.headers['x-tenant'], 'shop-1');
  assert.equal(req.headers['x-webhook-id'], event.id);
  assert.equal(req.headers['x-webhook-event'], 'order.paid');
  assert.equal(req.headers['x-webhook-delivery'], String(d.id));
  assert.equal(req.headers['x-webhook-attempt'], '1');
  assert.equal(req.headers['x-webhook-subscription'], sub.id);
  assert.equal(req.headers.authorization, undefined);
  assert.ok(Signer.verify(secret, req.body, String(req.headers['x-webhook-signature']), { now: clock.now() }), 'signature verifies with the subscriber secret against the raw body');
  assert.deepEqual(worker.counters, { succeeded: 1, failed: 0, retried: 0, disabled: 0 });
});

test('Worker: retry schedule, then success; rotation signs with both secrets', async (t) => {
  let calls = 0;
  const rx = await receiver(() => (++calls < 3 ? { status: 503, body: 'busy' } : { status: 200 }));
  t.after(rx.close);
  const { subscriptionService: s, eventService: ev, worker, deliveries, subscriptions, clock } = testService();
  const { row: sub, secret: first } = s.create({ name: 'a', url: `${rx.url}/x`, events: ['*'] }, 'console');
  const { deliveries: [d] } = ev.publish({ type: 'order.paid', data: {} }, 'x');
  await worker.tick();
  let r = /** @type {import('../src/types.js').DeliveryRow} */ (deliveries.get(d.id));
  assert.deepEqual([r.status, r.attempt, r.http_status, iso(r.next_attempt_at)], ['retrying', 1, 503, iso(clock.now() + 5_000)]);
  assert.match(String(r.error), /responded 503: busy/);
  assert.equal(subscriptions.get(sub.id)?.last_status, null, 'no outcome until the delivery finishes');
  await worker.tick();
  assert.equal(deliveries.get(d.id)?.attempt, 1, 'not due yet');
  clock.advance(5_000);
  const rotated = s.rotate(sub.id);
  await worker.tick();
  r = /** @type {import('../src/types.js').DeliveryRow} */ (deliveries.get(d.id));
  assert.deepEqual([r.status, r.attempt, iso(r.next_attempt_at)], ['retrying', 2, iso(clock.now() + 10_000)]);
  clock.advance(10_000);
  await worker.tick();
  r = /** @type {import('../src/types.js').DeliveryRow} */ (deliveries.get(d.id));
  assert.deepEqual([r.status, r.attempt, r.error, r.http_status], ['succeeded', 3, null, 200]);
  assert.deepEqual(JSON.parse(r.attempts).map((/** @type {any} */ a) => [a.n, a.httpStatus]), [[1, 503], [2, 503], [3, 200]]);
  const last = rx.received[2];
  assert.ok(Signer.verify(rotated.secret, last.body, String(last.headers['x-webhook-signature']), { now: clock.now() }), 'new secret');
  assert.ok(Signer.verify(first, last.body, String(last.headers['x-webhook-signature']), { now: clock.now() }), 'old secret still valid in the grace');
  assert.equal(subscriptions.get(sub.id)?.last_status, 'succeeded');
  assert.deepEqual(worker.counters, { succeeded: 1, failed: 0, retried: 2, disabled: 0 });
});

test('Worker: dead deliveries count against the subscription; disabled after the threshold; resume resets', async (t) => {
  const rx = await receiver((req) => ({ status: req.url === '/gone' ? 404 : 500 }));
  t.after(rx.close);
  const { subscriptionService: s, eventService: ev, worker, deliveries, subscriptions, clock } = testService({ DISABLE_AFTER_FAILURES: '2', RETRY_SCHEDULE_SEC: '1' });
  const { row: sub } = s.create({ name: 'a', url: `${rx.url}/gone`, events: ['*'] }, 'console');
  const { deliveries: [d1] } = ev.publish({ type: 'a', data: {} }, 'x');
  await worker.tick();
  assert.deepEqual([deliveries.get(d1.id)?.status, deliveries.get(d1.id)?.attempt], ['failed', 1], '404 is not retried');
  let sr = /** @type {import('../src/types.js').SubscriptionRow} */ (subscriptions.get(sub.id));
  assert.deepEqual([sr.status, sr.consecutive_failures, sr.last_status], ['active', 1, 'failed']);
  const { deliveries: [d2] } = ev.publish({ type: 'b', data: {} }, 'x');
  const { deliveries: [d3] } = ev.publish({ type: 'c', data: {} }, 'x');
  await worker.tick();
  sr = /** @type {import('../src/types.js').SubscriptionRow} */ (subscriptions.get(sub.id));
  assert.deepEqual([sr.status, sr.consecutive_failures], ['disabled', 3], 'second dead delivery crossed the threshold');
  assert.equal(worker.counters.disabled, 1);
  assert.equal(ev.publish({ type: 'd', data: {} }, 'x').deliveries.length, 0, 'a disabled subscription receives no new events');
  assert.equal(rx.received.length, 3);
  s.update(sub.id, { url: `${rx.url}/fixed`, enabled: true });
  assert.deepEqual([subscriptions.get(sub.id)?.status, subscriptions.get(sub.id)?.consecutive_failures], ['active', 0], 'resume resets the counter');
  assert.equal(ev.replay(sub.id, { from: clock.now() - 1_000, to: clock.now() + 1 }).queued, 4, 'replay queues the missed window: a, b, c, d');
  await worker.tick();
  assert.equal(deliveries.list({ subscriptionId: sub.id, status: 'retrying' }, { limit: 10 }).length, 4, '500 from /fixed retries');
  clock.advance(1_000);
  await worker.tick();
  assert.equal(deliveries.list({ subscriptionId: sub.id, status: 'failed' }, { limit: 10 }).length, 7, 'schedule of one retry exhausted for all four');
  sr = /** @type {import('../src/types.js').SubscriptionRow} */ (subscriptions.get(sub.id));
  assert.deepEqual([sr.status, sr.consecutive_failures], ['disabled', 4], 'disabled again once the fresh counter crosses the threshold');
  assert.deepEqual([d2, d3].map((d) => deliveries.get(d.id)?.status), ['failed', 'failed']);
});

test('Worker: paused subscriptions queue; timeouts retry; recovery after a crash; concurrency; retention', async (t) => {
  const rx = await receiver(() => ({ status: 200, delayMs: 300 }));
  t.after(rx.close);
  const { subscriptionService: s, eventService: ev, worker, deliveries, events, clock } = testService({ WORKER_CONCURRENCY: '1', EVENT_RETENTION_DAYS: '7' });
  const { row: paused } = s.create({ name: 'p', url: `${rx.url}/p`, events: ['*'], enabled: false }, 'console');
  const { row: live } = s.create({ name: 'l', url: `${rx.url}/l`, events: ['*'] }, 'console');
  const { deliveries: ds } = ev.publish({ type: 'x', data: {} }, 'x');
  assert.equal(ds.length, 1, 'paused subscriptions get no deliveries for new events');
  ev.test(paused.id, 'console');
  const { deliveries: [second] } = ev.publish({ type: 'y', data: {} }, 'x');
  await worker.tick();
  assert.deepEqual(ds.concat(second).map((d) => deliveries.get(d.id)?.status), ['succeeded', 'pending'], 'one slot: second waits');
  assert.equal(deliveries.list({ subscriptionId: paused.id }, { limit: 5 })[0].status, 'pending', 'test delivery waits while paused');
  s.update(paused.id, { enabled: true });
  await worker.tick();
  await worker.tick();
  assert.deepEqual(deliveries.list({}, { limit: 5 }).map((d) => d.status), ['succeeded', 'succeeded', 'succeeded']);

  // Crash: claim without executing, then recover.
  const { deliveries: [d] } = ev.publish({ type: 'z', data: {} }, 'x');
  const [claimed] = deliveries.claim(clock.now(), 1, 30_000, 1_000_000); // default LEASE_MS
  assert.equal(claimed.id, d.id);
  clock.advance(31_000); // past the lease, so recover() (Stage 6: only reclaims expired leases) picks it up
  worker.recover();
  const rec = /** @type {import('../src/types.js').DeliveryRow} */ (deliveries.get(d.id));
  assert.deepEqual([rec.status, rec.error, rec.attempt, iso(rec.next_attempt_at)], ['retrying', 'interrupted by restart', 1, iso(clock.now() + 5_000)]);

  // Timeout is retryable.
  const slow = testService();
  const { eventService: sev, subscriptionService: ss, worker: sw, deliveries: sd } = slow;
  ss.create({ name: 's', url: `${rx.url}/slow`, events: ['*'] }, 'console');
  sw.caller.timeoutMs = 100;
  const { deliveries: [sdl] } = sev.publish({ type: 'x', data: {} }, 'x');
  await sw.tick();
  assert.equal(sd.get(sdl.id)?.status, 'retrying');
  assert.match(String(sd.get(sdl.id)?.error), /timed out after 100ms/);

  // Retention purges old events, but NOT (Stage 6) while a delivery is still pending/retrying/
  // running — a paused subscriber's still-queued work must survive past its event's retention.
  const old = clock.now() - 8 * 86_400_000;
  events.insert({ id: 'evt_0000000000000001', type: 'old', data: '{}', idem_key: null, source: 'x', only_subscription: null, created_at: old });
  const stillQueued = deliveries.insert({ eventId: 'evt_0000000000000001', subscriptionId: live.id, maxAttempts: 1, nextAttemptAt: clock.now() + 3_600_000 }, old);
  worker.lastMaintenance = 0;
  await worker.tick();
  assert.ok(events.get('evt_0000000000000001'), 'kept: its delivery is still pending');
  assert.equal(deliveries.get(stillQueued.id)?.status, 'pending', 'the delivery itself is untouched by purge');

  // Once the delivery reaches a terminal state, the next purge removes the event (and, by cascade, the delivery).
  deliveries.cancel(stillQueued.id, 'test cleanup', clock.now());
  worker.lastMaintenance = 0;
  await worker.tick();
  assert.equal(events.get('evt_0000000000000001'), undefined, 'purged now that nothing is still queued for it');
  assert.equal(deliveries.list({ eventId: 'evt_0000000000000001' }, { limit: 5 }).length, 0);
});
