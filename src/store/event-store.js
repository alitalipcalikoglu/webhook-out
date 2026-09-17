import { WebhookError } from '../domain/errors.js';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').EventRow} EventRow */

/** Persistence for published events. */
export class EventStore {
  static COLUMNS = 'seq, id, type, data, idem_key, source, only_subscription, created_at';

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const C = EventStore.COLUMNS;
    this.stmt = {
      insert: db.prepare(`INSERT INTO events (id, type, data, idem_key, source, only_subscription, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
      get: db.prepare(`SELECT ${C} FROM events WHERE id = ?`),
      byIdem: db.prepare(`SELECT ${C} FROM events WHERE source = ? AND idem_key = ?`),
      range: db.prepare(`SELECT ${C} FROM events WHERE created_at >= ? AND created_at < ? AND only_subscription IS NULL ORDER BY seq LIMIT ?`),
      // A paused/broken subscriber's still-queued (or in-flight) work must not be destroyed by
      // retention purge just because the event that created it happens to be old — the cascade on
      // events -> deliveries is real (ON DELETE CASCADE, db.js), so this exclusion is load-bearing,
      // not decorative.
      purge: db.prepare(`DELETE FROM events WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM deliveries WHERE deliveries.event_id = events.id AND deliveries.status IN ('pending', 'retrying', 'running'))`),
      types: db.prepare(`SELECT type, COUNT(*) AS n, MAX(created_at) AS last FROM events WHERE only_subscription IS NULL GROUP BY type ORDER BY type`),
      countSince: db.prepare(`SELECT COUNT(*) AS n FROM events WHERE created_at >= ? AND only_subscription IS NULL`),
      total: db.prepare(`SELECT COUNT(*) AS n FROM events`),
    };
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.cache = new Map();
  }

  /** @param {Omit<EventRow, 'seq'>} e */
  insert(e) {
    const seq = Number(this.stmt.insert.run(e.id, e.type, e.data, e.idem_key, e.source, e.only_subscription, e.created_at).lastInsertRowid);
    return { ...e, seq };
  }

  /** @param {string} id */
  get(id) {
    return /** @type {EventRow|undefined} */ (this.stmt.get.get(id));
  }

  /** @param {string} id */
  require(id) {
    const row = this.get(id);
    if (!row) throw new WebhookError('EVENT_NOT_FOUND', `event "${id}" not found`);
    return row;
  }

  /** @param {string} source @param {string} idemKey */
  byIdempotencyKey(source, idemKey) {
    return /** @type {EventRow|undefined} */ (this.stmt.byIdem.get(source, idemKey));
  }

  /**
   * Real (non-test) events in a time window, oldest first.
   * @param {number} from @param {number} to @param {number} limit
   */
  range(from, to, limit) {
    return /** @type {EventRow[]} */ (this.stmt.range.all(from, to, limit));
  }

  /**
   * Newest first. `beforeSeq` for keyset paging.
   * @param {{ type?: string }} f
   * @param {{ limit: number, beforeSeq?: number }} page
   * @returns {EventRow[]}
   */
  list(f, { limit, beforeSeq }) {
    /** @type {string[]} */ const where = ['only_subscription IS NULL'];
    /** @type {(string|number)[]} */ const params = [];
    if (f.type !== undefined) { where.push('type = ?'); params.push(f.type); }
    if (beforeSeq !== undefined) { where.push('seq < ?'); params.push(beforeSeq); }
    const sql = `SELECT ${EventStore.COLUMNS} FROM events WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`;
    let stmt = this.cache.get(sql);
    if (!stmt) { stmt = this.db.prepare(sql); this.cache.set(sql, stmt); }
    return /** @type {EventRow[]} */ (stmt.all(...params, limit));
  }

  types() {
    return /** @type {{ type: string, n: number, last: number }[]} */ (this.stmt.types.all()).map((r) => ({ type: r.type, count: Number(r.n), lastAt: Number(r.last) }));
  }

  /** @param {number} since */
  countSince(since) {
    return Number(/** @type {{ n: number }} */ (this.stmt.countSince.get(since)).n);
  }

  total() {
    return Number(/** @type {{ n: number }} */ (this.stmt.total.get()).n);
  }

  /** Deletes events (and, by cascade, their deliveries) older than `before`. @param {number} before */
  purge(before) {
    return Number(this.stmt.purge.run(before).changes);
  }
}
