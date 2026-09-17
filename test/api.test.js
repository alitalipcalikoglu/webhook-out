import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUBLISH_KEY, READ_KEY, RW_KEY, WRITE_KEY, bearer, buildApp, receiver } from './helpers.js';

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('API: probes, auth and roles', async (t) => {
  const { app } = await buildApp(undefined, { version: pkgVersion });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  assert.equal(json(await app.inject({ url: '/ready' })).worker, 'stopped');
  const info = json(await app.inject({ url: '/v1/info' }));
  assert.equal(typeof info.schemaVersion, 'number');
  assert.equal(typeof info.serviceCore, 'string');
  delete info.schemaVersion;
  delete info.serviceCore;
  assert.deepEqual(info, { service: 'webhook-out', version: pkgVersion, apiVersion: 'v1', capabilities: ['replay', 'rotate', 'test-delivery', 'redeliver'] });
  assert.equal((await app.inject({ url: '/v1/subscriptions' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/subscriptions', headers: bearer(WRITE_KEY) })).statusCode, 403, 'write-only key cannot list');
  assert.equal((await app.inject({ url: '/v1/subscriptions', headers: bearer(PUBLISH_KEY) })).statusCode, 403, 'publish key cannot list');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(PUBLISH_KEY), payload: {} })).statusCode, 403, 'publish key cannot manage');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(READ_KEY), payload: { type: 'a' } })).statusCode, 403, 'read key cannot publish');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(PUBLISH_KEY), payload: { type: 'a', data: {} } })).statusCode, 202, 'publish key publishes');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(WRITE_KEY), payload: { type: 'a', data: {} } })).statusCode, 202, 'write key publishes too');
  assert.equal((await app.inject({ url: '/metrics', headers: bearer(PUBLISH_KEY) })).statusCode, 403);
  const res = await app.inject({ url: '/v1/subscriptions', headers: bearer(READ_KEY) });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('API: subscription lifecycle, secret shown once, rotate, list filters, validation', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  let res = await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(WRITE_KEY), payload: { name: 'kargocu-a', url: 'https://api.partner.example/hooks', events: ['order.paid', 'order.*'], headers: { 'X-Tenant': 'shop-1' }, description: 'Cargo partner' } });
  assert.equal(res.statusCode, 201, res.body);
  const { subscription: sub, secret } = json(res);
  assert.match(secret, /^whsec_/);
  assert.equal(res.headers.location, `/v1/subscriptions/${sub.id}`);
  assert.deepEqual([sub.status, sub.events, sub.headers, sub.createdBy, sub.consecutiveFailures, sub.lastStatus, sub.secretRotatedUntil], ['active', ['order.*', 'order.paid'], { 'x-tenant': 'shop-1' }, 'ops', 0, null, null]);
  assert.equal(JSON.stringify(sub).includes('whsec'), false, 'secret is not part of the subscription object');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(WRITE_KEY), payload: { name: 'kargocu-a', url: 'https://api.partner.example/x', events: ['*'] } })).statusCode, 409);
  res = await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(WRITE_KEY), payload: { name: 'x', url: 'https://evil.example/x', events: ['*'] } });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error.code, 'INVALID_URL');
  res = await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(WRITE_KEY), payload: { name: 'x', url: 'https://api.partner.example/x', events: ['Order.*'] } });
  assert.equal(json(res).error.code, 'INVALID_PATTERN');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(WRITE_KEY), payload: { name: 'x', url: 'https://api.partner.example/x', events: [] } })).statusCode, 400, 'schema: minItems');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(WRITE_KEY), payload: { name: 'x', url: 'https://api.partner.example/x', events: ['*'], secret: 'mine' } })).statusCode, 400, 'unknown field');

  await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(WRITE_KEY), payload: { name: 'muhasebe', url: 'https://api.partner.example/acc', events: ['invoice.*'], enabled: false } });
  let list = json(await app.inject({ url: '/v1/subscriptions', headers: bearer(READ_KEY) }));
  assert.deepEqual(list.items.map((/** @type {any} */ s) => [s.name, s.status]), [['kargocu-a', 'active'], ['muhasebe', 'paused']]);
  assert.deepEqual(json(await app.inject({ url: '/v1/subscriptions?status=paused', headers: bearer(READ_KEY) })).items.map((/** @type {any} */ s) => s.name), ['muhasebe']);
  assert.deepEqual(json(await app.inject({ url: '/v1/subscriptions?event=order.paid', headers: bearer(READ_KEY) })).items.map((/** @type {any} */ s) => s.name), ['kargocu-a']);
  assert.deepEqual(json(await app.inject({ url: '/v1/subscriptions?q=acc', headers: bearer(READ_KEY) })).items.map((/** @type {any} */ s) => s.name), ['muhasebe']);
  list = json(await app.inject({ url: '/v1/subscriptions?limit=1', headers: bearer(READ_KEY) }));
  assert.equal(list.nextCursor, 'kargocu-a');
  assert.deepEqual(json(await app.inject({ url: `/v1/subscriptions?limit=1&cursor=${list.nextCursor}`, headers: bearer(READ_KEY) })).nextCursor, null);

  res = await app.inject({ method: 'PATCH', url: `/v1/subscriptions/${sub.id}`, headers: bearer(WRITE_KEY), payload: { enabled: false, events: ['order.paid'] } });
  assert.deepEqual([json(res).subscription.status, json(res).subscription.events], ['paused', ['order.paid']]);
  assert.equal((await app.inject({ method: 'PATCH', url: `/v1/subscriptions/${sub.id}`, headers: bearer(WRITE_KEY), payload: {} })).statusCode, 400, 'empty patch');
  assert.equal((await app.inject({ url: '/v1/subscriptions/sub_0000000000000000', headers: bearer(READ_KEY) })).statusCode, 404);
  assert.equal((await app.inject({ url: '/v1/subscriptions/nope', headers: bearer(READ_KEY) })).statusCode, 400, 'id shape');

  res = await app.inject({ method: 'POST', url: `/v1/subscriptions/${sub.id}/rotate`, headers: { ...bearer(WRITE_KEY), 'content-type': 'application/json' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.notEqual(json(res).secret, secret);
  assert.ok(json(res).previousValidUntil);
  assert.ok(json(res).subscription.secretRotatedUntil);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/subscriptions/${sub.id}`, headers: bearer(WRITE_KEY) })).statusCode, 204);
  assert.equal((await app.inject({ url: `/v1/subscriptions/${sub.id}`, headers: bearer(READ_KEY) })).statusCode, 404);
});

test('API: publish, fan-out, idempotency, events, deliveries, test, replay, redeliver, cancel, stats, metrics', async (t) => {
  const rx = await receiver((req) => ({ status: req.url === '/fail' ? 500 : 200, body: '{"ok":1}' }));
  t.after(rx.close);
  const { app, worker, clock } = await buildApp();
  t.after(() => app.close());
  const okSub = json(await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(RW_KEY), payload: { name: 'ok', url: `${rx.url}/ok`, events: ['order.*'] } })).subscription;
  const badSub = json(await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(RW_KEY), payload: { name: 'bad', url: `${rx.url}/fail`, events: ['*'] } })).subscription;
  let res = await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(PUBLISH_KEY), payload: { type: 'order.paid', data: { orderId: 42 }, idempotencyKey: 'ord-42' } });
  assert.equal(res.statusCode, 202, res.body);
  const { event } = json(res);
  assert.deepEqual([json(res).deliveries, json(res).duplicate, event.source, event.idempotencyKey, event.test], [2, false, 'shop-backend', 'ord-42', false]);
  res = await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(PUBLISH_KEY), payload: { type: 'order.paid', data: { orderId: 42 }, idempotencyKey: 'ord-42' } });
  assert.deepEqual([res.statusCode, json(res).duplicate, json(res).event.id], [200, true, event.id]);
  res = await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(PUBLISH_KEY), payload: { type: 'Bad Type', data: {} } });
  assert.equal(json(res).error.code, 'INVALID_EVENT_TYPE');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(PUBLISH_KEY), payload: { type: 'a', data: 'x'.repeat(70_000) } })).statusCode, 413);

  await worker.tick();
  res = await app.inject({ url: `/v1/events/${event.id}`, headers: bearer(READ_KEY) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res).deliveries.map((/** @type {any} */ d) => [d.subscriptionId, d.status]).sort(), [[okSub.id, 'succeeded'], [badSub.id, 'retrying']].sort());
  const dead = json(res).deliveries.find((/** @type {any} */ d) => d.subscriptionId === badSub.id);
  assert.equal(dead.nextAttemptAt, new Date(clock.now() + 5_000).toISOString());

  let list = json(await app.inject({ url: '/v1/deliveries?status=retrying', headers: bearer(READ_KEY) }));
  assert.deepEqual(list.items.map((/** @type {any} */ d) => d.id), [dead.id]);
  assert.deepEqual(json(await app.inject({ url: `/v1/subscriptions/${okSub.id}/deliveries`, headers: bearer(READ_KEY) })).items.map((/** @type {any} */ d) => d.status), ['succeeded']);
  assert.deepEqual(json(await app.inject({ url: `/v1/deliveries?event=${event.id}&limit=1`, headers: bearer(READ_KEY) })).nextBefore, String(Math.max(...json(res).deliveries.map((/** @type {any} */ d) => d.id))));
  assert.equal(json(await app.inject({ url: `/v1/deliveries/${dead.id}`, headers: bearer(READ_KEY) })).delivery.attempts.length, 1);
  assert.equal((await app.inject({ url: '/v1/deliveries/999', headers: bearer(READ_KEY) })).statusCode, 404);

  res = await app.inject({ method: 'POST', url: `/v1/deliveries/${dead.id}/cancel`, headers: bearer(WRITE_KEY) });
  assert.equal(json(res).delivery.status, 'cancelled');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/deliveries/${dead.id}/cancel`, headers: bearer(WRITE_KEY) })).statusCode, 409);
  res = await app.inject({ method: 'POST', url: `/v1/deliveries/${dead.id}/redeliver`, headers: bearer(WRITE_KEY) });
  assert.equal(res.statusCode, 202, res.body);
  assert.deepEqual([json(res).delivery.status, json(res).delivery.eventId, json(res).delivery.id !== dead.id], ['pending', event.id, true]);

  res = await app.inject({ method: 'POST', url: `/v1/subscriptions/${okSub.id}/test`, headers: bearer(WRITE_KEY) });
  assert.equal(res.statusCode, 202, res.body);
  assert.deepEqual([json(res).event.type, json(res).event.test, json(res).delivery.subscriptionId], ['webhook.test', true, okSub.id]);
  await worker.tick();
  const testReq = rx.received.find((r) => r.headers['x-webhook-event'] === 'webhook.test');
  assert.ok(testReq, 'test event delivered');
  assert.equal(JSON.parse(/** @type {any} */ (testReq).body).data.name, 'ok');

  const events = json(await app.inject({ url: '/v1/events', headers: bearer(READ_KEY) }));
  assert.deepEqual(events.items.map((/** @type {any} */ e) => e.type), ['order.paid'], 'test events are not listed');
  assert.deepEqual(json(await app.inject({ url: '/v1/events?type=order.paid&limit=1', headers: bearer(READ_KEY) })).items.length, 1);
  assert.deepEqual(json(await app.inject({ url: '/v1/event-types', headers: bearer(READ_KEY) })).items.map((/** @type {any} */ x) => [x.type, x.count]), [['order.paid', 1]]);

  clock.advance(1_000); // the window end is exclusive and defaults to now
  res = await app.inject({ method: 'POST', url: `/v1/subscriptions/${okSub.id}/replay`, headers: bearer(WRITE_KEY), payload: { from: '2026-09-17T09:00:00Z' } });
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(json(res).queued, 1);
  assert.equal(json(await app.inject({ method: 'POST', url: `/v1/subscriptions/${okSub.id}/replay`, headers: bearer(WRITE_KEY), payload: { from: 'yesterday-around-nine-oclock' } })).error.code, 'INVALID_RANGE');

  const stats = json(await app.inject({ url: '/v1/stats', headers: bearer(READ_KEY) }));
  assert.deepEqual(stats.subscriptions, { active: 2, paused: 0, disabled: 0 });
  assert.deepEqual(stats.events, { total: 2, last24h: 1 });
  assert.deepEqual([stats.deliveries.byStatus.succeeded, stats.deliveries.byStatus.cancelled, stats.deliveries.backlog.queued], [2, 1, 2]);
  assert.deepEqual(stats.worker.sinceStart, { succeeded: 2, failed: 0, retried: 2, disabled: 0 }, 'the redelivered copy hit /fail once more');
  const metrics = await app.inject({ url: '/metrics', headers: bearer(READ_KEY) });
  assert.match(metrics.body, /webhook_subscriptions\{status="active"\} 2\n/);
  assert.match(metrics.body, /webhook_deliveries\{status="succeeded"\} 2\n/);
  assert.match(metrics.body, /webhook_backlog 2\n/);
  assert.match(metrics.body, /webhook_attempts_retried_total 2\n/);
});
