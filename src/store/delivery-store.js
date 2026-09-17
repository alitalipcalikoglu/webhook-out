import { randomUUID } from 'node:crypto';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').DeliveryRow} DeliveryRow */
/** @typedef {import('../types.js').DeliveryStatus} DeliveryStatus */
/** @typedef {import('../types.js').Attempt} Attempt */
/** @typedef {import('../types.js').FinishOutcome} FinishOutcome */

/**
 * Persistence for deliveries: the work queue (pending/retrying) and the history.
 *
 * Lease ownership (Stage 6): `claim()` hands each row a fresh random `owner_token` (the fencing
 * token) and a `lease_until`. Every write that ends a claimed attempt — {@link finish} and
 * {@link heartbeat} — is guarded by `WHERE owner_token = ? AND status = 'running'`, so it can only
 * ever affect the row it thinks it owns: a worker that claimed a delivery, then hung long enough
 * for another process to reclaim it (see {@link reclaimExpired}), can no longer overwrite that row
 * when it eventually returns — its `owner_token` no longer matches, and by then `status` isn't
 * `'running'` under it either. See `scheduler`'s `store/run-store.js` for the identical design
 * (kept independent, not shared, since the two services' state machines and columns differ).
 */
export class DeliveryStore {
  static COLUMNS = 'id, event_id, subscription_id, status, attempt, max_attempts, next_attempt_at, started_at, finished_at, duration_ms, http_status, response, error, attempts, created_at, owner_token, lease_until';
  static STATUSES = /** @type {const} */ (['pending', 'running', 'retrying', 'succeeded', 'failed', 'cancelled']);

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const C = DeliveryStore.COLUMNS;
    this.stmt = {
      insert: db.prepare(`INSERT INTO deliveries (event_id, subscription_id, status, attempt, max_attempts, next_attempt_at, created_at) VALUES (?, ?, 'pending', 0, ?, ?, ?)`),
      get: db.prepare(`SELECT ${C} FROM deliveries WHERE id = ?`),
      // Only active subscriptions receive calls; paused and disabled ones keep their queue.
      due: db.prepare(`SELECT ${DeliveryStore.COLUMNS.split(', ').map((c) => `d.${c}`).join(', ')} FROM deliveries d JOIN subscriptions s ON s.id = d.subscription_id WHERE d.status IN ('pending', 'retrying') AND d.next_attempt_at <= ? AND s.status = 'active' ORDER BY d.next_attempt_at, d.id LIMIT ?`),
      start: db.prepare(`UPDATE deliveries SET status = 'running', attempt = attempt + 1, started_at = ?, next_attempt_at = NULL, owner_token = ?, lease_until = ? WHERE id = ? AND status IN ('pending', 'retrying')`),
      finish: db.prepare(`UPDATE deliveries SET status = ?, finished_at = ?, duration_ms = ?, http_status = ?, response = ?, error = ?, attempts = ?, next_attempt_at = ?, owner_token = NULL, lease_until = NULL WHERE id = ? AND owner_token = ? AND status = 'running'`),
      heartbeat: db.prepare(`UPDATE deliveries SET lease_until = ? WHERE id = ? AND owner_token = ? AND status = 'running'`),
      cancel: db.prepare(`UPDATE deliveries SET status = 'cancelled', finished_at = ?, error = ?, next_attempt_at = NULL WHERE id = ? AND status IN ('pending', 'retrying')`),
      expiredLeases: db.prepare(`SELECT ${C} FROM deliveries WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)`),
      runningCount: db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE status = 'running'`),
      byStatus: db.prepare(`SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status`),
      recentByStatus: db.prepare(`SELECT status, COUNT(*) AS n FROM deliveries WHERE created_at >= ? GROUP BY status`),
      backlog: db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM deliveries WHERE status IN ('pending', 'retrying')`),
      recentFailures: db.prepare(`SELECT subscription_id, COUNT(*) AS n FROM deliveries WHERE created_at >= ? AND status = 'failed' GROUP BY subscription_id ORDER BY n DESC, subscription_id LIMIT ?`),
      avgDuration: db.prepare(`SELECT AVG(duration_ms) AS avg FROM deliveries WHERE created_at >= ? AND status = 'succeeded'`),
      forEvent: db.prepare(`SELECT ${C} FROM deliveries WHERE event_id = ? ORDER BY id`),
    };
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.cache = new Map();
  }

  /**
   * @param {{ eventId: string, subscriptionId: string, maxAttempts: number, nextAttemptAt: number }} d
   * @param {number} now
   */
  insert({ eventId, subscriptionId, maxAttempts, nextAttemptAt }, now) {
    const id = Number(this.stmt.insert.run(eventId, subscriptionId, maxAttempts, nextAttemptAt, now).lastInsertRowid);
    return /** @type {DeliveryRow} */ (this.get(id));
  }

  /** @param {number} id */
  get(id) {
    return /** @type {DeliveryRow|undefined} */ (this.stmt.get.get(id));
  }

  /** @param {string} eventId */
  forEvent(eventId) {
    return /** @type {DeliveryRow[]} */ (this.stmt.forEvent.all(eventId));
  }

  /**
   * Move due deliveries of active subscriptions to `running`, each with a fresh lease, and return
   * them. One transaction, so two loops (in this process or another sharing the file) never claim
   * the same row.
   * @param {number} now
   * @param {number} limit
   * @param {number} leaseMs
   */
  claim(now, limit, leaseMs) {
    return this.db.transaction(() => {
      const rows = /** @type {DeliveryRow[]} */ (this.stmt.due.all(now, limit));
      return rows.map((r) => { this.stmt.start.run(now, randomUUID(), now + leaseMs, r.id); return /** @type {DeliveryRow} */ (this.get(r.id)); });
    });
  }

  /**
   * Record an attempt's outcome, but only while `ownerToken` still holds the lease. Returns the
   * updated row, or `null` if the lease had already moved on (see {@link reclaimExpired}) — in
   * which case nothing was written and the caller must not treat this as a normal completion.
   * @param {number} id
   * @param {string} ownerToken
   * @param {FinishOutcome} o
   */
  finish(id, ownerToken, o) {
    const { changes } = this.stmt.finish.run(o.status, o.finishedAt, o.durationMs, o.httpStatus, o.response, o.error, JSON.stringify(o.attempts), o.nextAttemptAt, id, ownerToken);
    return Number(changes) > 0 ? /** @type {DeliveryRow} */ (this.get(id)) : null;
  }

  /**
   * Renew the lease while a call is still in flight. Returns whether `ownerToken` still holds it —
   * `false` means another process already reclaimed this delivery.
   * @param {number} id @param {string} ownerToken @param {number} now @param {number} leaseMs
   */
  heartbeat(id, ownerToken, now, leaseMs) {
    return Number(this.stmt.heartbeat.run(now + leaseMs, id, ownerToken).changes) > 0;
  }

  /**
   * Atomically find every delivery whose lease has expired (or predates leases) and, in the SAME
   * transaction, finish each one via `decide(delivery)` — a pure function computing the same shape
   * {@link finish} takes. See `scheduler`'s `run-store.js#reclaimExpired` for why running the read
   * and every write inside one transaction is what makes this race-free against a concurrent
   * {@link heartbeat}.
   * @param {number} now
   * @param {(d: DeliveryRow) => FinishOutcome} decide
   * @returns {DeliveryRow[]}
   */
  reclaimExpired(now, decide) {
    return this.db.transaction(() => {
      const stale = /** @type {DeliveryRow[]} */ (this.stmt.expiredLeases.all(now));
      return stale.map((d) => /** @type {DeliveryRow} */ (this.finish(d.id, /** @type {string} */ (d.owner_token), decide(d))));
    });
  }

  /** Live in-flight count, for an API-only process that has no in-process Worker to ask. */
  runningCount() {
    return Number(/** @type {{ n: number }} */ (this.stmt.runningCount.get()).n);
  }

  /** @param {number} id @param {string} reason @param {number} now */
  cancel(id, reason, now) {
    return Number(this.stmt.cancel.run(now, reason, id).changes) > 0;
  }

  /**
   * Newest first. `beforeId` for keyset paging.
   * @param {{ subscriptionId?: string, eventId?: string, status?: DeliveryStatus }} f
   * @param {{ limit: number, beforeId?: number }} page
   * @returns {DeliveryRow[]}
   */
  list(f, { limit, beforeId }) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const params = [];
    if (f.subscriptionId !== undefined) { where.push('subscription_id = ?'); params.push(f.subscriptionId); }
    if (f.eventId !== undefined) { where.push('event_id = ?'); params.push(f.eventId); }
    if (f.status !== undefined) { where.push('status = ?'); params.push(f.status); }
    if (beforeId !== undefined) { where.push('id < ?'); params.push(beforeId); }
    const sql = `SELECT ${DeliveryStore.COLUMNS} FROM deliveries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    let stmt = this.cache.get(sql);
    if (!stmt) { stmt = this.db.prepare(sql); this.cache.set(sql, stmt); }
    return /** @type {DeliveryRow[]} */ (stmt.all(...params, limit));
  }

  /** @param {number} since @param {number} [topN] */
  stats(since, topN = 10) {
    const count = (/** @type {{ status: string, n: number }[]} */ rows) => Object.fromEntries(DeliveryStore.STATUSES.map((s) => [s, Number(rows.find((r) => r.status === s)?.n ?? 0)]));
    const backlog = /** @type {{ n: number, oldest: number|null }} */ (this.stmt.backlog.get());
    const avg = /** @type {{ avg: number|null }} */ (this.stmt.avgDuration.get(since));
    return {
      byStatus: count(/** @type {any} */ (this.stmt.byStatus.all())),
      recentByStatus: count(/** @type {any} */ (this.stmt.recentByStatus.all(since))),
      backlog: { queued: Number(backlog.n), oldestAt: backlog.oldest === null ? null : Number(backlog.oldest) },
      recentFailures: /** @type {{ subscription_id: string, n: number }[]} */ (this.stmt.recentFailures.all(since, topN)).map((r) => ({ subscriptionId: r.subscription_id, failed: Number(r.n) })),
      recentAvgDurationMs: avg.avg === null ? null : Math.round(Number(avg.avg)),
    };
  }
}
