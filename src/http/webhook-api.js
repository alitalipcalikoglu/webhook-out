import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '../net/audit-client.js';
import { WebhookError } from '../domain/errors.js';
import { DeliveryStore } from '../store/delivery-store.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */

/** HTTP surface: subscriptions and deliveries (write/read roles), publishing (publish role). */
export class WebhookApi {
  static READY_CACHE_MS = 10_000;
  static STATS_WINDOW_MS = 86_400_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {import('../domain/subscription-service.js').SubscriptionService} deps.subscriptionService
   * @param {import('../domain/event-service.js').EventService} deps.eventService
   * @param {import('../store/subscription-store.js').SubscriptionStore} deps.subscriptions
   * @param {import('../store/event-store.js').EventStore} deps.events
   * @param {import('../store/delivery-store.js').DeliveryStore} deps.deliveries
   * @param {import('../worker.js').Worker} deps.worker
   * @param {import('../db.js').Database} deps.db
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('../net/audit-client.js').AuditClient} [deps.audit]
   */
  constructor({ config, audit, subscriptionService, eventService, subscriptions, events, deliveries, worker, db, logger }) {
    this.config = config;
    this.audit = audit;
    this.subs = subscriptionService;
    this.evs = eventService;
    this.subscriptions = subscriptions;
    this.events = events;
    this.deliveries = deliveries;
    this.worker = worker;
    this.db = db;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
    this.readyCache = { at: 0, ok: false, error: '' };
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      loggerInstance: this.logger,
      logger: this.logger ? undefined : { level: config.logLevel, redact: ['req.headers.authorization'] },
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      requestIdHeader: 'x-request-id',
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    app.decorateRequest('apiKey', /** @type {any} */ (null));
    // Action endpoints (rotate, test, redeliver, cancel) take no body; clients that always send a JSON content type must not get a parse error.
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      if (body === '') return done(null, undefined);
      try {
        done(null, JSON.parse(/** @type {string} */ (body)));
      } catch {
        done(Object.assign(new Error('body is not valid JSON'), { statusCode: 400, code: 'INVALID_JSON' }), undefined);
      }
    });
    app.setErrorHandler(this.#errorHandler);
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'no-store');
    });
    this.#registerProbes(app);
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** @type {FastifyInstance['errorHandler']} */
  #errorHandler = (rawErr, request, reply) => {
    const err = /** @type {import('fastify').FastifyError & { validation?: { instancePath: string, message?: string, params: object }[] }} */ (rawErr);
    if (err instanceof WebhookError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: err.message, details: err.validation.map((v) => ({ path: v.instancePath, message: v.message, params: v.params })) },
      });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
    return reply.code(status).send({ error: { code: err.code ?? 'REQUEST_ERROR', message: err.message } });
  };

  /** @param {FastifyInstance} app */
  #registerProbes(app) {
    app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
    app.get('/ready', { logLevel: 'warn' }, async (_request, reply) => {
      const ready = this.#readiness();
      if (!ready.ok) {
        app.log.warn({ error: ready.error }, 'readiness check failed');
        return reply.code(503).send({ status: 'unavailable', error: ready.error });
      }
      return { status: 'ok', worker: this.worker.running ? 'running' : 'stopped' };
    });
  }

  #readiness() {
    const now = Date.now();
    if (now - this.readyCache.at > WebhookApi.READY_CACHE_MS) {
      try {
        this.db.ping();
        this.readyCache = { at: now, ok: true, error: '' };
      } catch (err) {
        this.readyCache = { at: now, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return this.readyCache;
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKey.id,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    // Role checks run before body validation so a wrong role gets 403, not a schema error.
    const read = { preValidation: ApiKeyAuth.require('read') };
    const write = { preValidation: ApiKeyAuth.require('write') };
    const publish = { preValidation: ApiKeyAuth.require('publish') };
    const pid = (/** @type {FastifyRequest} */ r) => /** @type {{ id: string }} */ (r.params).id;
    const nid = (/** @type {FastifyRequest} */ r) => Number(pid(r));
    const query = (/** @type {FastifyRequest} */ r) => /** @type {Record<string, string|undefined>} */ (r.query);
    const actor = (/** @type {FastifyRequest} */ r) => r.apiKey.id;
    const parseIso = (/** @type {string|undefined} */ s, /** @type {string} */ field) => {
      if (s === undefined) return undefined;
      const t = Date.parse(s);
      if (Number.isNaN(t)) throw new WebhookError('INVALID_RANGE', `${field} must be an ISO 8601 date-time`);
      return t;
    };

    // ---- subscriptions
    api.post('/subscriptions', { config: { audit: AuditClient.route('webhook.subscription.create', (_r, b) => ({ type: 'subscription', id: b.subscription.id })) }, ...write, schema: { body: Schemas.createSubscription } }, async (request, reply) => {
      const { row, secret } = this.subs.create(/** @type {any} */ (request.body), actor(request));
      reply.header('location', `/v1/subscriptions/${row.id}`);
      return reply.code(201).send({ subscription: Views.subscription(row), secret });
    });
    api.get('/subscriptions', { ...read, schema: { querystring: Schemas.subscriptionsQuery } }, async (request) => {
      const q = query(request);
      const { items, nextCursor } = this.subs.list({ q: q.q, status: q.status, event: q.event }, { limit: q.limit ? Number(q.limit) : 50, cursor: q.cursor });
      return { items: items.map(Views.subscription), nextCursor };
    });
    api.get('/subscriptions/:id', { ...read, schema: { params: Schemas.subParams } }, async (request) => ({ subscription: Views.subscription(this.subs.get(pid(request))) }));
    api.patch('/subscriptions/:id', { config: { audit: AuditClient.route('webhook.subscription.update', (r) => ({ type: 'subscription', id: /** @type {any} */ (r.params).id }), (r) => ({ patch: r.body })) }, ...write, schema: { params: Schemas.subParams, body: Schemas.patchSubscription } }, async (request) => ({ subscription: Views.subscription(this.subs.update(pid(request), /** @type {any} */ (request.body))) }));
    api.delete('/subscriptions/:id', { config: { audit: AuditClient.route('webhook.subscription.delete', (r) => ({ type: 'subscription', id: /** @type {any} */ (r.params).id })) }, ...write, schema: { params: Schemas.subParams } }, async (request, reply) => {
      this.subs.remove(pid(request));
      return reply.code(204).send();
    });
    api.post('/subscriptions/:id/rotate', { config: { audit: AuditClient.route('webhook.subscription.rotate', (r) => ({ type: 'subscription', id: /** @type {any} */ (r.params).id })) }, ...write, schema: { params: Schemas.subParams } }, async (request) => {
      const { row, secret, previousValidUntil } = this.subs.rotate(pid(request));
      return { subscription: Views.subscription(row), secret, previousValidUntil };
    });
    api.post('/subscriptions/:id/test', { config: { audit: AuditClient.route('webhook.subscription.test', (r) => ({ type: 'subscription', id: /** @type {any} */ (r.params).id })) }, ...write, schema: { params: Schemas.subParams } }, async (request, reply) => {
      const { event, delivery } = this.evs.test(pid(request), actor(request));
      return reply.code(202).send({ event: Views.event(event), delivery: Views.delivery(delivery) });
    });
    api.post('/subscriptions/:id/replay', { config: { audit: AuditClient.route('webhook.subscription.replay', (r) => ({ type: 'subscription', id: /** @type {any} */ (r.params).id }), (r, b) => ({ ...(/** @type {object} */ (r.body ?? {})), queued: b?.queued })) }, ...write, schema: { params: Schemas.subParams, body: Schemas.replay } }, async (request, reply) => {
      const b = /** @type {{ from: string, to?: string }} */ (request.body);
      const out = this.evs.replay(pid(request), { from: /** @type {number} */ (parseIso(b.from, 'from')), to: parseIso(b.to, 'to') });
      return reply.code(202).send(out);
    });
    api.get('/subscriptions/:id/deliveries', { ...read, schema: { params: Schemas.subParams, querystring: Schemas.deliveriesQuery } }, async (request) => {
      this.subs.get(pid(request));
      return this.#deliveries({ ...query(request), subscription: pid(request) });
    });

    // ---- events
    api.post('/events', { ...publish, schema: { body: Schemas.publish } }, async (request, reply) => {
      const { event, deliveries, duplicate } = this.evs.publish(/** @type {any} */ (request.body), actor(request));
      return reply.code(duplicate ? 200 : 202).send({ event: Views.event(event), deliveries: deliveries.length, duplicate });
    });
    api.get('/events', { ...read, schema: { querystring: Schemas.eventsQuery } }, async (request) => {
      const q = query(request);
      const limit = q.limit ? Number(q.limit) : 50;
      const rows = this.events.list({ type: q.type }, { limit: limit + 1, beforeSeq: q.before ? Number(q.before) : undefined });
      const items = rows.slice(0, limit);
      return { items: items.map(Views.event), nextBefore: rows.length > limit ? String(items[items.length - 1].seq) : null };
    });
    api.get('/events/:id', { ...read, schema: { params: Schemas.evtParams } }, async (request) => {
      const e = this.events.require(pid(request));
      return { event: Views.event(e), deliveries: this.deliveries.forEvent(e.id).map(Views.delivery) };
    });
    api.get('/event-types', read, async () => ({ items: this.events.types().map((t) => ({ ...t, lastAt: Views.iso(t.lastAt) })) }));

    // ---- deliveries
    api.get('/deliveries', { ...read, schema: { querystring: Schemas.deliveriesQuery } }, async (request) => this.#deliveries(query(request)));
    api.get('/deliveries/:id', { ...read, schema: { params: Schemas.idParams } }, async (request) => ({ delivery: Views.delivery(this.evs.delivery(nid(request))) }));
    api.post('/deliveries/:id/redeliver', { config: { audit: AuditClient.route('webhook.delivery.redeliver', (r) => ({ type: 'delivery', id: /** @type {any} */ (r.params).id })) }, ...write, schema: { params: Schemas.idParams } }, async (request, reply) => reply.code(202).send({ delivery: Views.delivery(this.evs.redeliver(nid(request))) }));
    api.post('/deliveries/:id/cancel', { config: { audit: AuditClient.route('webhook.delivery.cancel', (r) => ({ type: 'delivery', id: /** @type {any} */ (r.params).id })) }, ...write, schema: { params: Schemas.idParams } }, async (request) => ({ delivery: Views.delivery(this.evs.cancel(nid(request))) }));

    api.get('/stats', read, async () => this.#stats());
  }

  /** @param {Record<string, string|undefined>} q */
  #deliveries(q) {
    const limit = q.limit ? Number(q.limit) : 50;
    const rows = this.deliveries.list({ subscriptionId: q.subscription, eventId: q.event, status: /** @type {any} */ (q.status) }, { limit: limit + 1, beforeId: q.before ? Number(q.before) : undefined });
    const items = rows.slice(0, limit);
    return { items: items.map(Views.delivery), nextBefore: rows.length > limit ? String(items[items.length - 1].id) : null };
  }

  #stats() {
    const now = Date.now();
    const since = now - WebhookApi.STATS_WINDOW_MS;
    const d = this.deliveries.stats(since);
    return {
      subscriptions: this.subscriptions.counts(),
      events: { total: this.events.total(), last24h: this.events.countSince(since) },
      deliveries: { byStatus: d.byStatus, last24h: d.recentByStatus, backlog: { queued: d.backlog.queued, oldestAt: Views.iso(d.backlog.oldestAt) }, avgDurationMs24h: d.recentAvgDurationMs, topFailures24h: d.recentFailures },
      worker: { running: this.worker.running, inFlight: this.worker.inFlight.size, concurrency: this.config.workerConcurrency, sinceStart: { ...this.worker.counters } },
    };
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preValidation: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const s = this.subscriptions.counts();
      const d = this.deliveries.stats(Date.now() - WebhookApi.STATS_WINDOW_MS);
      const c = this.worker.counters;
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP webhook_subscriptions Subscriptions by status.',
        '# TYPE webhook_subscriptions gauge',
        `webhook_subscriptions{status="active"} ${s.active}`,
        `webhook_subscriptions{status="paused"} ${s.paused}`,
        `webhook_subscriptions{status="disabled"} ${s.disabled}`,
        '# HELP webhook_events_total Stored events.',
        '# TYPE webhook_events_total gauge',
        `webhook_events_total ${this.events.total()}`,
        '# HELP webhook_deliveries Stored deliveries by status.',
        '# TYPE webhook_deliveries gauge',
        ...DeliveryStore.STATUSES.map((st) => `webhook_deliveries{status="${st}"} ${d.byStatus[st]}`),
        '# HELP webhook_deliveries_finished_total Delivery outcomes since process start.',
        '# TYPE webhook_deliveries_finished_total counter',
        `webhook_deliveries_finished_total{status="succeeded"} ${c.succeeded}`,
        `webhook_deliveries_finished_total{status="failed"} ${c.failed}`,
        '# HELP webhook_attempts_retried_total Attempts that failed and were rescheduled since process start.',
        '# TYPE webhook_attempts_retried_total counter',
        `webhook_attempts_retried_total ${c.retried}`,
        '# HELP webhook_subscriptions_disabled_total Subscriptions disabled for consecutive failures since process start.',
        '# TYPE webhook_subscriptions_disabled_total counter',
        `webhook_subscriptions_disabled_total ${c.disabled}`,
        '# HELP webhook_backlog Queued and retrying deliveries.',
        '# TYPE webhook_backlog gauge',
        `webhook_backlog ${d.backlog.queued}`,
        '# HELP webhook_oldest_queued_age_seconds Age of the oldest queued delivery, 0 when none.',
        '# TYPE webhook_oldest_queued_age_seconds gauge',
        `webhook_oldest_queued_age_seconds ${d.backlog.oldestAt === null ? 0 : ((Date.now() - d.backlog.oldestAt) / 1000).toFixed(0)}`,
        '# HELP webhook_in_flight Calls currently executing.',
        '# TYPE webhook_in_flight gauge',
        `webhook_in_flight ${this.worker.inFlight.size}`,
        '# HELP webhook_process_uptime_seconds Process uptime.',
        '# TYPE webhook_process_uptime_seconds gauge',
        `webhook_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
