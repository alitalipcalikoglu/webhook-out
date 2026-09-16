/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').DeliveryRow} DeliveryRow */
/** @typedef {import('../types.js').DeliveryStatus} DeliveryStatus */
/** @typedef {import('../types.js').Attempt} Attempt */

/** Persistence for deliveries: the work queue (pending/retrying) and the history. */
export class DeliveryStore {
  static COLUMNS = 'id, event_id, subscription_id, status, attempt, max_attempts, next_attempt_at, started_at, finished_at, duration_ms, http_status, response, error, attempts, created_at';
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
      start: db.prepare(`UPDATE deliveries SET status = 'running', attempt = attempt + 1, started_at = ?, next_attempt_at = NULL WHERE id = ? AND status IN ('pending', 'retrying')`),
      finish: db.prepare(`UPDATE deliveries SET status = ?, finished_at = ?, duration_ms = ?, http_status = ?, response = ?, error = ?, attempts = ?, next_attempt_at = ? WHERE id = ?`),
      cancel: db.prepare(`UPDATE deliveries SET status = 'cancelled', finished_at = ?, error = ?, next_attempt_at = NULL WHERE id = ? AND status IN ('pending', 'retrying')`),
      running: db.prepare(`SELECT ${C} FROM deliveries WHERE status = 'running'`),
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
   * Move due deliveries of active subscriptions to `running`. One transaction, so two loops
   * never claim the same row.
   * @param {number} now
   * @param {number} limit
   */
  claim(now, limit) {
    return this.db.transaction(() => {
      const rows = /** @type {DeliveryRow[]} */ (this.stmt.due.all(now, limit));
      return rows.map((r) => { this.stmt.start.run(now, r.id); return /** @type {DeliveryRow} */ (this.get(r.id)); });
    });
  }

  /**
   * @param {number} id
   * @param {{ status: 'succeeded'|'failed'|'retrying', finishedAt: number|null, durationMs: number, httpStatus: number|null, response: string|null, error: string|null, attempts: Attempt[], nextAttemptAt: number|null }} o
   */
  finish(id, o) {
    this.stmt.finish.run(o.status, o.finishedAt, o.durationMs, o.httpStatus, o.response, o.error, JSON.stringify(o.attempts), o.nextAttemptAt, id);
    return /** @type {DeliveryRow} */ (this.get(id));
  }

  /** @param {number} id @param {string} reason @param {number} now */
  cancel(id, reason, now) {
    return Number(this.stmt.cancel.run(now, reason, id).changes) > 0;
  }

  /** Deliveries left `running` by a previous process. */
  running() {
    return /** @type {DeliveryRow[]} */ (this.stmt.running.all());
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
