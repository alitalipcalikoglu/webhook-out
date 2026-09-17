import { Config } from './config.js';
import { AuditClient } from '@atc-web/service-core/audit';
import { Lifecycle } from '@atc-web/service-core/lifecycle';
import { ConsoleLogger } from '@atc-web/service-core/log';
import { SecretBox } from './crypto/secret-box.js';
import { Database } from './db.js';
import { EventService } from './domain/event-service.js';
import { SubscriptionService } from './domain/subscription-service.js';
import { WebhookApi } from './http/webhook-api.js';
import { HttpCaller } from './net/http-caller.js';
import { NetGuard } from '@atc-web/service-core/http';
import { DeliveryStore } from './store/delivery-store.js';
import { EventStore } from './store/event-store.js';
import { HeartbeatStore } from './store/heartbeat-store.js';
import { SubscriptionStore } from './store/subscription-store.js';
import { Worker } from './worker.js';

/** @typedef {'combined'|'api'|'worker'} Role */

/**
 * Composition root: wires configuration, storage, domain, outbound calls, HTTP and the worker,
 * and owns the process lifecycle.
 *
 * `role` (Stage 6) picks which of the two runtimes this process actually runs — see `scheduler`'s
 * `Application` module doc for the identical reasoning (`'combined'` default, `'api'`: HTTP only
 * no `Worker`, `'worker'`: `Worker` only no HTTP listener at all).
 */
export class Application {
  /**
   * @param {Config} config
   * @param {{ role?: Role }} [opts]
   */
  constructor(config, { role = 'combined' } = {}) {
    this.config = config;
    this.role = role;
    this.audit = new AuditClient({ target: config.audit });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.subscriptions = new SubscriptionStore(this.db);
    this.events = new EventStore(this.db);
    this.deliveries = new DeliveryStore(this.db);
    this.presence = new HeartbeatStore(this.db);
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

  /**
   * Build from `process.env`; exits with a readable message on bad configuration.
   * @param {{ role?: Role }} [opts]
   */
  static fromEnv(opts) {
    try {
      return new Application(Config.fromEnv(), opts);
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config, role } = this;
    const runsApi = role !== 'worker';
    const runsWorker = role !== 'api';

    /** @type {import('./types.js').MinimalLogger} */
    let log = new ConsoleLogger({ level: /** @type {any} */ (config.logLevel) });

    if (runsWorker) {
      // Stage 6.1: drainMs bounds the worker's own wait for in-flight calls, strictly less than
      // forceExitMs below (same call-timeout ceiling, smaller margin) so a stuck drain logs and
      // lets the remaining shutdown steps at least attempt to run before the process force-exits.
      this.worker = new Worker({ events: this.eventService, subscriptionService: this.subscriptionService, subscriptions: this.subscriptions, deliveries: this.deliveries, eventStore: this.events, presence: this.presence, caller: this.caller, log: log.child({ component: 'worker' }), options: { concurrency: config.workerConcurrency, pollMs: config.pollMs, retentionDays: config.eventRetentionDays, disableAfterFailures: config.disableAfterFailures, leaseMs: config.leaseMs, heartbeatMs: config.heartbeatMs, drainMs: config.deliveryTimeoutMs + 5_000 } });
    }

    /** @type {(() => (void|Promise<void>))[]} */
    const steps = [];

    if (runsApi) {
      const api = new WebhookApi({ config, audit: this.audit, subscriptionService: this.subscriptionService, eventService: this.eventService, subscriptions: this.subscriptions, events: this.events, deliveries: this.deliveries, presence: this.presence, worker: this.worker, db: this.db });
      const app = await api.build();
      this.app = app;
      log = app.log;
      if (this.worker) this.worker.log = app.log.child({ component: 'worker' });
    }

    // Shutdown order (Stage 6 fix): stop claiming new work first, then stop HTTP intake, THEN
    // drain whatever the worker already had in flight, THEN flush audit, THEN close the DB. Audit
    // used to flush before the worker drained — see `scheduler`'s `application.js` for the full
    // reasoning (identical fix, same bug class). `worker.stop()` now has its own bounded drain
    // wait (`drainMs` above, Stage 6.1) strictly shorter than `forceExitMs` below, so a stuck drain
    // logs and moves on to the remaining steps before the whole process gets force-killed.
    if (this.worker) steps.push(() => /** @type {Worker} */ (this.worker).stopClaiming());
    if (this.app) steps.push(() => this.app?.close());
    if (this.worker) steps.push(() => /** @type {Worker} */ (this.worker).stop());
    steps.push(() => this.audit.close());
    steps.push(() => this.db.close());

    const { shutdown } = Lifecycle.install({ forceExitMs: config.deliveryTimeoutMs + 10_000, log, steps });
    this.shutdown = shutdown;
    this.audit.logger = log;
    this.audit.start();

    if (this.app) {
      await this.app.listen({ port: config.port, host: config.host });
      this.app.log.info({ tls: config.tls !== null, role, subscriptions: this.subscriptions.counts(), retrySchedule: config.retryScheduleSec }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    } else {
      log.info({ role }, 'worker-only process: no HTTP listener');
    }
    if (this.worker) this.worker.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }
}
