import { Config } from './config.js';
import { AuditClient } from '@atc-web/service-core/audit';
import { Lifecycle } from '@atc-web/service-core/lifecycle';
import { SecretBox } from './crypto/secret-box.js';
import { Database } from './db.js';
import { EventService } from './domain/event-service.js';
import { SubscriptionService } from './domain/subscription-service.js';
import { WebhookApi } from './http/webhook-api.js';
import { HttpCaller } from './net/http-caller.js';
import { NetGuard } from '@atc-web/service-core/http';
import { DeliveryStore } from './store/delivery-store.js';
import { EventStore } from './store/event-store.js';
import { SubscriptionStore } from './store/subscription-store.js';
import { Worker } from './worker.js';

/**
 * Composition root: wires configuration, storage, domain, outbound calls, HTTP and the worker,
 * and owns the process lifecycle.
 */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.audit = new AuditClient({ target: config.audit });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.subscriptions = new SubscriptionStore(this.db);
    this.events = new EventStore(this.db);
    this.deliveries = new DeliveryStore(this.db);
    const guard = new NetGuard({ allowHttp: config.targetAllowHttp, allowPrivate: config.targetAllowPrivate, allowedHosts: config.targetAllowedHosts });
    this.subscriptionService = new SubscriptionService({ subscriptions: this.subscriptions, guard, box: new SecretBox(config.secretsKey), options: config });
    this.eventService = new EventService({ db: this.db, events: this.events, deliveries: this.deliveries, subscriptions: this.subscriptions, options: config });
    this.caller = new HttpCaller({ guard, timeoutMs: config.deliveryTimeoutMs });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {Worker|null} */
    this.worker = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const worker = new Worker({ events: this.eventService, subscriptionService: this.subscriptionService, subscriptions: this.subscriptions, deliveries: this.deliveries, eventStore: this.events, caller: this.caller, log: /** @type {any} */ (console), options: { concurrency: config.workerConcurrency, pollMs: config.pollMs, retentionDays: config.eventRetentionDays, disableAfterFailures: config.disableAfterFailures } });
    this.worker = worker;
    const api = new WebhookApi({ config, audit: this.audit, subscriptionService: this.subscriptionService, eventService: this.eventService, subscriptions: this.subscriptions, events: this.events, deliveries: this.deliveries, worker, db: this.db });
    const app = await api.build();
    this.app = app;
    worker.log = app.log.child({ component: 'worker' });
    // Order preserved exactly as before this extraction (audit flushes before the worker drains
    // in-flight deliveries) — a known, separately tracked defect, not something to fix here.
    const { shutdown } = Lifecycle.install({
      forceExitMs: this.config.deliveryTimeoutMs + 10_000,
      log: app.log,
      steps: [
        () => this.app?.close(),
        () => this.audit.close(),
        () => this.worker?.stop(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, subscriptions: this.subscriptions.counts(), retrySchedule: config.retryScheduleSec }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    worker.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }

}
