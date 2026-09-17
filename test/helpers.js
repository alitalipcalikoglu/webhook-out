import { createServer } from 'node:http';
import { Config } from '../src/config.js';
import { SecretBox } from '../src/crypto/secret-box.js';
import { Database } from '../src/db.js';
import { EventService } from '../src/domain/event-service.js';
import { SubscriptionService } from '../src/domain/subscription-service.js';
import { WebhookApi } from '../src/http/webhook-api.js';
import { HttpCaller } from '../src/net/http-caller.js';
import { NetGuard } from '@atc-web/service-core/http';
import { DeliveryStore } from '../src/store/delivery-store.js';
import { EventStore } from '../src/store/event-store.js';
import { SubscriptionStore } from '../src/store/subscription-store.js';
import { Worker } from '../src/worker.js';

export const RW_KEY = 'k'.repeat(40);
export const READ_KEY = 'r'.repeat(40);
export const WRITE_KEY = 'w'.repeat(40);
export const PUBLISH_KEY = 'p'.repeat(40);
export const SECRETS_KEY = 'ab'.repeat(32);

/** @param {Record<string, string>} [overrides] */
export function testEnv(overrides = {}) {
  return {
    PORT: '0',
    WEBHOOK_API_KEYS: `console:${RW_KEY},dashboard:${READ_KEY}:read,ops:${WRITE_KEY}:write,shop-backend:${PUBLISH_KEY}:publish`,
    SECRETS_KEY,
    TARGET_ALLOW_HTTP: 'true',
    TARGET_ALLOW_PRIVATE: 'true',
    TARGET_ALLOWED_HOSTS: '127.0.0.1,api.partner.example',
    RETRY_SCHEDULE_SEC: '5,10,20',
    DISABLE_AFTER_FAILURES: '2',
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    POLL_MS: '100',
    ...overrides,
  };
}

/** @param {Record<string, string>} [overrides] */
export function testConfig(overrides) {
  return Config.fromEnv(testEnv(overrides));
}

/** A settable clock so tests control time. */
export class FakeClock {
  /** @param {number} start */
  constructor(start) {
    this.t = start;
  }

  now = () => this.t;

  /** @param {number} ms */
  advance(ms) {
    this.t += ms;
    return this.t;
  }
}

const silent = /** @type {any} */ ({ info() {}, warn() {}, error() {}, fatal() {}, debug() {}, trace() {}, child() { return this; } });

/** Wired domain objects over an in-memory database. @param {Record<string, string>} [overrides] */
export function testService(overrides) {
  const config = testConfig(overrides);
  const clock = new FakeClock(Date.parse('2026-09-17T10:00:00Z'));
  const db = new Database(':memory:');
  const subscriptions = new SubscriptionStore(db);
  const events = new EventStore(db);
  const deliveries = new DeliveryStore(db);
  const guard = new NetGuard({ allowHttp: config.targetAllowHttp, allowPrivate: config.targetAllowPrivate, allowedHosts: config.targetAllowedHosts });
  const box = new SecretBox(config.secretsKey);
  const subscriptionService = new SubscriptionService({ subscriptions, guard, box, options: config, now: clock.now });
  const eventService = new EventService({ db, events, deliveries, subscriptions, options: config, now: clock.now });
  const caller = new HttpCaller({ guard, timeoutMs: config.deliveryTimeoutMs, now: clock.now });
  const worker = new Worker({ events: eventService, subscriptionService, subscriptions, deliveries, eventStore: events, caller, log: silent, options: { concurrency: config.workerConcurrency, pollMs: config.pollMs, retentionDays: config.eventRetentionDays, disableAfterFailures: config.disableAfterFailures }, now: clock.now });
  return { config, clock, db, subscriptions, events, deliveries, guard, box, subscriptionService, eventService, caller, worker };
}

/** Fully wired Fastify app. @param {Record<string, string>} [overrides] @param {object} [deps] Extra constructor deps, e.g. an AuditClient. */
export async function buildApp(overrides, deps = {}) {
  const t = testService(overrides);
  const app = await new WebhookApi({ ...t, ...deps, logger: silent }).build();
  await app.ready();
  return { app, ...t };
}

/** @param {string} key */
export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}

/**
 * @typedef {{ method: string, url: string, headers: import('node:http').IncomingHttpHeaders, body: string }} Received
 */

/**
 * Local HTTP receiver that records what it gets and answers as told.
 * @param {(req: Received) => { status: number, body?: string, delayMs?: number }} answer
 */
export async function receiver(answer) {
  /** @type {Received[]} */
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      received.push(r);
      const a = answer(r);
      setTimeout(() => { res.writeHead(a.status, { 'content-type': 'application/json' }); res.end(a.body ?? '{"ok":true}'); }, a.delayMs ?? 0);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return { url: `http://127.0.0.1:${port}`, received, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}
