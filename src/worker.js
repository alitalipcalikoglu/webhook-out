import { setTimeout as sleep } from 'node:timers/promises';

/** @typedef {import('./types.js').DeliveryRow} DeliveryRow */
/** @typedef {import('./types.js').Attempt} Attempt */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * Background loop: claims due deliveries of active subscriptions up to the concurrency limit,
 * calls the receivers and records outcomes with the retry schedule. Tracks consecutive dead
 * deliveries per subscription and disables it past the threshold. Recovers deliveries interrupted
 * by a previous process and purges events past retention.
 */
export class Worker {
  static MAINTENANCE_INTERVAL_MS = 60_000;

  /**
   * @param {object} deps
   * @param {import('./domain/event-service.js').EventService} deps.events
   * @param {import('./domain/subscription-service.js').SubscriptionService} deps.subscriptionService
   * @param {import('./store/subscription-store.js').SubscriptionStore} deps.subscriptions
   * @param {import('./store/delivery-store.js').DeliveryStore} deps.deliveries
   * @param {import('./store/event-store.js').EventStore} deps.eventStore
   * @param {import('./net/http-caller.js').HttpCaller} deps.caller
   * @param {Logger} deps.log
   * @param {{ concurrency: number, pollMs: number, retentionDays: number, disableAfterFailures: number }} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ events, subscriptionService, subscriptions, deliveries, eventStore, caller, log, options, now = Date.now }) {
    this.events = events;
    this.subscriptionService = subscriptionService;
    this.subscriptions = subscriptions;
    this.deliveries = deliveries;
    this.eventStore = eventStore;
    this.caller = caller;
    this.log = log;
    this.options = options;
    this.now = now;
    this.running = false;
    /** @type {Promise<void>|null} */
    this.loop = null;
    this.abort = new AbortController();
    /** @type {Set<Promise<void>>} */
    this.inFlight = new Set();
    this.lastMaintenance = 0;
    this.counters = { succeeded: 0, failed: 0, retried: 0, disabled: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.recover();
    this.lastMaintenance = this.now();
    this.loop = this.#run();
    this.log.info({ concurrency: this.options.concurrency, pollMs: this.options.pollMs }, 'worker started');
  }

  /** Stop claiming and wait for in-flight calls to finish. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    await this.loop;
    await Promise.allSettled(this.inFlight);
    this.loop = null;
    this.log.info('worker stopped');
  }

  /** Deliveries left `running` by a crash count as a failed attempt and follow the retry schedule. */
  recover() {
    const now = this.now();
    const interrupted = this.deliveries.running();
    for (const d of interrupted) this.#settle(d, { startedAt: d.started_at ?? now, error: 'interrupted by restart', httpStatus: null, response: null, retryable: true }, now);
    if (interrupted.length) this.log.warn({ n: interrupted.length }, 'recovered deliveries interrupted by a previous process');
  }

  /**
   * One pass: claim due deliveries into free slots. Awaits the calls it started, so tests see
   * final state; the loop itself does not wait.
   * @param {number} [now]
   */
  async tick(now = this.now()) {
    this.#pass(now);
    await Promise.allSettled([...this.inFlight]);
  }

  /** @param {number} now */
  #pass(now) {
    this.#maintenance(now);
    const free = this.options.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    const claimed = this.deliveries.claim(now, free);
    for (const d of claimed) {
      const p = this.#execute(d).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
    return claimed.length;
  }

  async #run() {
    while (this.running) {
      try {
        this.#pass(this.now());
      } catch (err) {
        this.log.error({ err }, 'worker iteration failed');
      }
      try {
        await sleep(this.options.pollMs, undefined, { signal: this.abort.signal });
      } catch {
        // aborted by stop()
      }
    }
  }

  /** @param {DeliveryRow} d */
  async #execute(d) {
    const startedAt = this.now();
    const sub = this.subscriptions.get(d.subscription_id);
    const event = this.eventStore.get(d.event_id);
    if (!sub || !event) { this.#settle(d, { startedAt, error: 'subscription or event no longer exists', httpStatus: null, response: null, retryable: false }, this.now()); return; }
    try {
      const body = JSON.stringify({ id: event.id, type: event.type, createdAt: new Date(event.created_at).toISOString(), data: JSON.parse(event.data) });
      const result = await this.caller.call({ url: sub.url, headers: JSON.parse(sub.headers), secrets: this.subscriptionService.signingSecrets(sub), body, event: { id: event.id, type: event.type }, delivery: d.id, attempt: d.attempt, subscription: sub.id });
      this.#settle(d, { startedAt, error: null, httpStatus: result.httpStatus, response: result.response, retryable: false }, this.now());
    } catch (err) {
      const e = /** @type {{ message: string, httpStatus?: number|null, response?: string, retryable?: boolean }} */ (err);
      this.#settle(d, { startedAt, error: e.message, httpStatus: e.httpStatus ?? null, response: e.response || null, retryable: e.retryable === true }, this.now());
    }
  }

  /**
   * Persist an attempt's outcome and decide: succeeded, retrying (per schedule) or failed. A
   * finished delivery updates the subscription's counters and may disable it.
   * @param {DeliveryRow} d
   * @param {{ startedAt: number, error: string|null, httpStatus: number|null, response: string|null, retryable: boolean }} o
   * @param {number} now
   */
  #settle(d, o, now) {
    const durationMs = Math.max(0, now - o.startedAt);
    /** @type {Attempt[]} */
    const attempts = [...JSON.parse(d.attempts), { n: d.attempt, startedAt: new Date(o.startedAt).toISOString(), durationMs, httpStatus: o.httpStatus, error: o.error }];
    const delay = o.error !== null && o.retryable && d.attempt < d.max_attempts ? this.events.retryDelayMs(d.attempt) : null;
    const status = o.error === null ? 'succeeded' : delay !== null ? 'retrying' : 'failed';
    const updated = this.deliveries.finish(d.id, { status, finishedAt: status === 'retrying' ? null : now, durationMs, httpStatus: o.httpStatus, response: o.response, error: o.error, attempts, nextAttemptAt: delay === null ? null : now + delay });
    const meta = { delivery: d.id, event: d.event_id, subscription: d.subscription_id, attempt: d.attempt, status, httpStatus: o.httpStatus, durationMs, nextAttemptAt: updated.next_attempt_at };
    if (status === 'retrying') {
      this.counters.retried++;
      this.log.warn({ ...meta, error: o.error }, 'attempt failed, retry scheduled');
      return updated;
    }
    this.counters[status]++;
    const sub = this.subscriptions.get(d.subscription_id);
    if (sub) {
      const failures = status === 'succeeded' ? 0 : sub.consecutive_failures + 1;
      const disable = status === 'failed' && sub.status === 'active' && failures >= this.options.disableAfterFailures;
      this.subscriptions.recordOutcome(sub.id, { at: now, status, consecutiveFailures: failures, subscriptionStatus: disable ? 'disabled' : sub.status });
      if (disable) { this.counters.disabled++; this.log.error({ subscription: sub.id, name: sub.name, failures }, 'subscription disabled after consecutive failed deliveries'); }
    }
    if (status === 'succeeded') this.log.info(meta, 'delivered');
    else this.log.error({ ...meta, error: o.error }, 'delivery failed');
    return updated;
  }

  /** @param {number} now */
  #maintenance(now) {
    if (now - this.lastMaintenance < Worker.MAINTENANCE_INTERVAL_MS) return;
    this.lastMaintenance = now;
    const purged = this.eventStore.purge(now - this.options.retentionDays * 86_400_000);
    if (purged) this.log.info({ purged }, 'purged events past retention');
  }
}
