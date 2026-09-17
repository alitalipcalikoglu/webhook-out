import { setTimeout as sleep } from 'node:timers/promises';

/** @typedef {import('./types.js').DeliveryRow} DeliveryRow */
/** @typedef {import('./types.js').Attempt} Attempt */
/** @typedef {import('./types.js').FinishOutcome} FinishOutcome */
/** @typedef {import('./types.js').MinimalLogger} MinimalLogger */

/**
 * Background loop: claims due deliveries of active subscriptions up to the concurrency limit,
 * calls the receivers and records outcomes with the retry schedule. Tracks consecutive dead
 * deliveries per subscription and disables it past the threshold. Reclaims deliveries whose lease
 * expired (a previous process's crash, or this process's own hung call) and purges events past
 * retention.
 *
 * Lease ownership: see `scheduler`'s `worker.js` module doc — the design is identical (claim hands
 * out an `owner_token` + `lease_until`, a heartbeat renews it while a call is in flight, `finish`
 * is fenced on that same token), kept as an independent copy per service rather than shared,
 * since the state machines and store shapes differ.
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
   * @param {import('./store/heartbeat-store.js').HeartbeatStore} deps.presence
   * @param {import('./net/http-caller.js').HttpCaller} deps.caller
   * @param {MinimalLogger} deps.log
   * @param {{ concurrency: number, pollMs: number, retentionDays: number, disableAfterFailures: number, leaseMs: number, heartbeatMs: number, drainMs: number, subscriptionConcurrencyMax: number }} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ events, subscriptionService, subscriptions, deliveries, eventStore, presence, caller, log, options, now = Date.now }) {
    this.events = events;
    this.subscriptionService = subscriptionService;
    this.subscriptions = subscriptions;
    this.deliveries = deliveries;
    this.eventStore = eventStore;
    this.presence = presence;
    this.caller = caller;
    this.log = log;
    this.options = options;
    this.now = now;
    this.running = false;
    /** Guards claiming specifically, so shutdown can stop taking new work before it starts draining. Defaults true so `tick()` (no `start()` call) claims normally. */
    this.claiming = true;
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
    this.claiming = true;
    this.abort = new AbortController();
    this.recover();
    this.lastMaintenance = this.now();
    this.loop = this.#run();
    this.log.info({ concurrency: this.options.concurrency, pollMs: this.options.pollMs, leaseMs: this.options.leaseMs, heartbeatMs: this.options.heartbeatMs }, 'worker started');
  }

  /** Stop claiming new work; in-flight calls keep running until {@link stop} drains them. */
  stopClaiming() {
    this.claiming = false;
  }

  /**
   * Stop claiming (if not already) and wait for in-flight calls to finish, bounded by
   * `options.drainMs` (Stage 6.1) — under ordinary operation every in-flight call already has its
   * own real timeout (`DELIVERY_TIMEOUT_MS`), so the drain finishes well within `drainMs`. If it
   * doesn't (a call somehow bypassed its own timeout), this stops waiting and logs loudly rather
   * than hanging the whole shutdown sequence forever.
   */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.claiming = false;
    this.abort.abort();
    await this.loop;
    // The losing side of this race must be cancelled explicitly: node:timers/promises' sleep()
    // otherwise keeps its timer alive for the full drainMs even after in-flight draining already
    // won the race — harmless in production (process.exit() doesn't wait on pending timers) but it
    // visibly hangs anything that inspects the event loop (tests included) for up to drainMs.
    const drainAbort = new AbortController();
    const outcome = await Promise.race([
      Promise.allSettled(this.inFlight).then(() => /** @type {const} */ ('drained')),
      sleep(this.options.drainMs, undefined, { signal: drainAbort.signal }).then(() => /** @type {const} */ ('timed-out')).catch(() => /** @type {const} */ ('timed-out')),
    ]);
    drainAbort.abort();
    if (outcome === 'timed-out') this.log.error({ inFlight: this.inFlight.size, drainMs: this.options.drainMs }, 'drain timed out; continuing shutdown with deliveries still in flight');
    this.loop = null;
    this.log.info('worker stopped');
  }

  /**
   * Deliveries left `running` by a crash count as a failed attempt and follow the retry schedule.
   * Called once at startup; every `running` row at that point is necessarily from a previous life
   * of this process. See {@link #reclaimStale} for the in-loop counterpart.
   */
  recover() {
    const recovered = this.#reclaim('interrupted by restart');
    if (recovered.length) this.log.warn({ n: recovered.length }, 'recovered deliveries interrupted by a previous process');
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
    this.presence.beat(now);
    this.#reclaimStale();
    this.#maintenance(now);
    if (!this.claiming) return 0;
    const free = this.options.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    const claimed = this.deliveries.claim(now, free, this.options.leaseMs, this.options.subscriptionConcurrencyMax);
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
    const ownerToken = /** @type {string} */ (d.owner_token);
    const heartbeat = setInterval(() => {
      const ok = this.deliveries.heartbeat(d.id, ownerToken, this.now(), this.options.leaseMs);
      if (!ok) this.log.warn({ delivery: d.id, subscription: d.subscription_id }, 'heartbeat found the lease already reassigned; ownership lost mid-call');
    }, this.options.heartbeatMs).unref();
    try {
      const sub = this.subscriptions.get(d.subscription_id);
      const event = this.eventStore.get(d.event_id);
      /** @type {{ startedAt: number, error: string|null, httpStatus: number|null, response: string|null, retryable: boolean }} */
      let outcome;
      if (!sub || !event) {
        outcome = { startedAt, error: 'subscription or event no longer exists', httpStatus: null, response: null, retryable: false };
      } else {
        try {
          const body = JSON.stringify({ id: event.id, type: event.type, createdAt: new Date(event.created_at).toISOString(), data: JSON.parse(event.data) });
          const result = await this.caller.call({ url: sub.url, headers: JSON.parse(sub.headers), secrets: this.subscriptionService.signingSecrets(sub), body, event: { id: event.id, type: event.type }, delivery: d.id, attempt: d.attempt, subscription: sub.id });
          outcome = { startedAt, error: null, httpStatus: result.httpStatus, response: result.response, retryable: false };
        } catch (err) {
          const e = /** @type {{ message: string, httpStatus?: number|null, response?: string, retryable?: boolean }} */ (err);
          outcome = { startedAt, error: e.message, httpStatus: e.httpStatus ?? null, response: e.response || null, retryable: e.retryable === true };
        }
      }
      const now = this.now();
      const decision = this.#decide(d, outcome, now);
      const updated = this.deliveries.finish(d.id, ownerToken, decision);
      if (updated === null) {
        this.log.warn({ delivery: d.id, subscription: d.subscription_id }, 'lease lost before this attempt could be recorded; result discarded, another worker already reclaimed it');
        return;
      }
      this.#applyOutcome(updated, decision.status, now);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Pure: an attempt's outcome reduced to the shape `DeliveryStore.finish` takes. No I/O.
   * @param {DeliveryRow} d
   * @param {{ startedAt: number, error: string|null, httpStatus: number|null, response: string|null, retryable: boolean }} o
   * @param {number} now
   * @returns {FinishOutcome}
   */
  #decide(d, o, now) {
    const durationMs = Math.max(0, now - o.startedAt);
    /** @type {Attempt[]} */
    const attempts = [...JSON.parse(d.attempts), { n: d.attempt, startedAt: new Date(o.startedAt).toISOString(), durationMs, httpStatus: o.httpStatus, error: o.error }];
    const delay = o.error !== null && o.retryable && d.attempt < d.max_attempts ? this.events.retryDelayMs(d.attempt) : null;
    const status = o.error === null ? 'succeeded' : delay !== null ? 'retrying' : 'failed';
    return { status, finishedAt: status === 'retrying' ? null : now, durationMs, httpStatus: o.httpStatus, response: o.response, error: o.error, attempts, nextAttemptAt: delay === null ? null : now + delay };
  }

  /**
   * Side effects once an outcome is durably written: counters, the subscription's failure streak
   * and possible auto-disable, and logging.
   * @param {DeliveryRow} d The row as `finish` returned it.
   * @param {'succeeded'|'retrying'|'failed'} status
   * @param {number} now
   */
  #applyOutcome(d, status, now) {
    const meta = { delivery: d.id, event: d.event_id, subscription: d.subscription_id, attempt: d.attempt, status, httpStatus: d.http_status, durationMs: d.duration_ms, nextAttemptAt: d.next_attempt_at };
    if (status === 'retrying') {
      this.counters.retried++;
      this.log.warn({ ...meta, error: d.error }, 'attempt failed, retry scheduled');
      return;
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
    else this.log.error({ ...meta, error: d.error }, 'delivery failed');
  }

  /**
   * Atomically reclaim every delivery whose lease has expired, labeling the reason `error`, and
   * apply each outcome. Shared by {@link recover} (startup, "interrupted by restart") and
   * {@link #reclaimStale} (in-loop, "lease expired").
   * @param {string} error
   */
  #reclaim(error) {
    const now = this.now();
    const recovered = this.deliveries.reclaimExpired(now, (d) => this.#decide(d, { startedAt: d.started_at ?? now, error, httpStatus: null, response: null, retryable: true }, now));
    for (const d of recovered) this.#applyOutcome(d, /** @type {'retrying'|'failed'} */ (d.status), now);
    return recovered;
  }

  /**
   * In-loop counterpart to {@link recover}: catches a delivery whose lease expired without a
   * heartbeat (this process's own hung call, or another process's crash) without waiting for a
   * restart.
   */
  #reclaimStale() {
    const recovered = this.#reclaim('lease expired');
    if (recovered.length) this.log.warn({ n: recovered.length }, 'reclaimed deliveries whose lease expired without a heartbeat');
  }

  /** @param {number} now */
  #maintenance(now) {
    if (now - this.lastMaintenance < Worker.MAINTENANCE_INTERVAL_MS) return;
    this.lastMaintenance = now;
    const purged = this.eventStore.purge(now - this.options.retentionDays * 86_400_000);
    if (purged) this.log.info({ purged }, 'purged events past retention');
    const staleHeartbeats = this.presence.purgeStale(now, Worker.MAINTENANCE_INTERVAL_MS * 5);
    if (staleHeartbeats) this.log.debug({ staleHeartbeats }, 'purged stale worker_heartbeat rows');
  }
}
