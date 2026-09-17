import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Application } from '../src/application.js';
import { Config } from '../src/config.js';
import { bearer, buildApp, READ_KEY, receiver, testEnv, WRITE_KEY } from './helpers.js';

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);

/**
 * `Application.start()` end to end for each role, without going through `Lifecycle`'s `shutdown()`
 * (which calls `process.exit()` on success). See `scheduler`'s identical test for why.
 */
async function cleanup(/** @type {Application} */ app) {
  await app.worker?.stop();
  await app.audit.close();
  app.app?.close();
  app.db.close();
}

test('Runtime: api-only role builds no Worker; the process never claims a delivery', async () => {
  const app = new Application(Config.fromEnv(testEnv()), { role: 'api' });
  await app.start();
  try {
    assert.equal(app.worker, null);
    assert.ok(app.app, 'HTTP listener is built');
    app.subscriptionService.create({ name: 's', url: 'https://api.partner.example/x', events: ['*'] }, 'console');
    const { deliveries } = app.eventService.publish({ type: 'x', data: {} }, 'src');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(app.deliveries.get(deliveries[0].id)?.status, 'pending', 'nothing in this process ever claims it');
  } finally {
    await cleanup(app);
  }
});

test('Runtime: worker-only role builds no HTTP listener but still processes deliveries', async () => {
  const rx = await receiver(() => ({ status: 200 }));
  try {
    const app = new Application(Config.fromEnv(testEnv()), { role: 'worker' });
    await app.start();
    try {
      assert.equal(app.app, null, 'no Fastify instance at all');
      assert.ok(app.worker?.running);
      app.subscriptionService.create({ name: 's', url: `${rx.url}/x`, events: ['*'] }, 'console');
      const { deliveries } = app.eventService.publish({ type: 'x', data: {} }, 'src');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(app.deliveries.get(deliveries[0].id)?.status, 'succeeded');
    } finally {
      await cleanup(app);
    }
  } finally {
    await rx.close();
  }
});

test('API (worker: null): /ready and /v1/stats fall back to worker_heartbeat and runningCount', async (t) => {
  const { app, presence } = await buildApp(undefined, { worker: null });
  t.after(() => app.close());
  let ready = await app.inject({ url: '/ready' });
  assert.equal(json(ready).worker, 'stopped', 'no heartbeat ever recorded');
  presence.beat(Date.now()); // workerStatus() reads real wall-clock time, not the injectable test clock
  ready = await app.inject({ url: '/ready' });
  assert.equal(json(ready).worker, 'running', 'a recent heartbeat reads as running even with no in-process Worker');

  await app.inject({ method: 'POST', url: '/v1/subscriptions', headers: bearer(WRITE_KEY), payload: { name: 's', url: 'https://api.partner.example/x', events: ['*'] } });
  const stats = json(await app.inject({ url: '/v1/stats', headers: bearer(READ_KEY) }));
  assert.deepEqual(stats.worker, { running: true, inFlight: 0, concurrency: 16, sinceStart: null }, 'sinceStart counters are not reconstructable from the DB, reported null rather than a misleading zero');
});

test('Runtime: shutdown order — stop claiming, then HTTP intake, then drain in-flight, then audit flush, then DB close', async (t) => {
  const rx = await receiver(() => ({ status: 200, delayMs: 60 }));
  t.after(rx.close);
  const app = new Application(Config.fromEnv(testEnv()), { role: 'combined' });
  await app.start();
  /** @type {string[]} */
  const order = [];
  const worker = /** @type {import('../src/worker.js').Worker} */ (app.worker);
  const http = /** @type {import('fastify').FastifyInstance} */ (app.app);
  const wrap = (/** @type {object} */ obj, /** @type {string} */ method, /** @type {string} */ label) => {
    const orig = /** @type {(...a: unknown[]) => unknown} */ (/** @type {any} */ (obj)[method]).bind(obj);
    /** @type {any} */ (obj)[method] = async (/** @type {unknown[]} */ ...a) => { order.push(label); return orig(...a); };
  };
  wrap(worker, 'stopClaiming', 'stopClaiming');
  wrap(http, 'close', 'app.close');
  wrap(worker, 'stop', 'worker.stop');
  wrap(app.audit, 'close', 'audit.close');
  wrap(app.db, 'close', 'db.close');

  app.subscriptionService.create({ name: 's', url: `${rx.url}/x`, events: ['*'] }, 'console');
  app.eventService.publish({ type: 'x', data: {} }, 'src');
  await new Promise((r) => setTimeout(r, 20)); // let the worker claim it before shutdown begins

  const realExit = process.exit;
  let exitCode;
  process.exit = /** @type {any} */ ((/** @type {number} */ code) => { exitCode = code; });
  try {
    await app.shutdown('test');
  } finally {
    process.exit = realExit;
  }
  assert.deepEqual(order, ['stopClaiming', 'app.close', 'worker.stop', 'audit.close', 'db.close']);
  assert.equal(exitCode, 0, 'a clean shutdown, not the force-exit/error path');
});
