import { WebhookError } from '../domain/errors.js';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').SubscriptionRow} SubscriptionRow */

/** Persistence for subscriptions. */
export class SubscriptionStore {
  static COLUMNS = 'id, name, description, url, events, headers, secret_enc, prev_secret_enc, prev_until, status, consecutive_failures, last_delivery_at, last_status, created_by, created_at, updated_at, ordered';

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const C = SubscriptionStore.COLUMNS;
    this.stmt = {
      insert: db.prepare(`INSERT INTO subscriptions (${C}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      get: db.prepare(`SELECT ${C} FROM subscriptions WHERE id = ?`),
      byName: db.prepare(`SELECT ${C} FROM subscriptions WHERE name = ?`),
      update: db.prepare(`UPDATE subscriptions SET name = ?, description = ?, url = ?, events = ?, headers = ?, secret_enc = ?, prev_secret_enc = ?, prev_until = ?, status = ?, consecutive_failures = ?, updated_at = ?, ordered = ? WHERE id = ?`),
      delete: db.prepare(`DELETE FROM subscriptions WHERE id = ?`),
      active: db.prepare(`SELECT ${C} FROM subscriptions WHERE status = 'active'`),
      outcome: db.prepare(`UPDATE subscriptions SET last_delivery_at = ?, last_status = ?, consecutive_failures = ?, status = ? WHERE id = ?`),
      counts: db.prepare(`SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status`),
    };
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.cache = new Map();
  }

  /** @param {SubscriptionRow} r */
  insert(r) {
    this.stmt.insert.run(r.id, r.name, r.description, r.url, r.events, r.headers, r.secret_enc, r.prev_secret_enc, r.prev_until, r.status, r.consecutive_failures, r.last_delivery_at, r.last_status, r.created_by, r.created_at, r.updated_at, r.ordered);
    return r;
  }

  /** @param {string} id */
  get(id) {
    return /** @type {SubscriptionRow|undefined} */ (this.stmt.get.get(id));
  }

  /** @param {string} name */
  byName(name) {
    return /** @type {SubscriptionRow|undefined} */ (this.stmt.byName.get(name));
  }

  /** @param {string} id */
  require(id) {
    const row = this.get(id);
    if (!row) throw new WebhookError('SUBSCRIPTION_NOT_FOUND', `subscription "${id}" not found`);
    return row;
  }

  /** @param {SubscriptionRow} r */
  update(r) {
    this.stmt.update.run(r.name, r.description, r.url, r.events, r.headers, r.secret_enc, r.prev_secret_enc, r.prev_until, r.status, r.consecutive_failures, r.updated_at, r.ordered, r.id);
    return r;
  }

  /** @param {string} id */
  delete(id) {
    return Number(this.stmt.delete.run(id).changes) > 0;
  }

  /** Every subscription that receives new events. */
  active() {
    return /** @type {SubscriptionRow[]} */ (this.stmt.active.all());
  }

  /**
   * Record the end of a delivery: last outcome, the consecutive-failure counter and, when the
   * counter crosses the threshold, the automatic `disabled` status.
   * @param {string} id
   * @param {{ at: number, status: 'succeeded'|'failed', consecutiveFailures: number, subscriptionStatus: import('../types.js').SubscriptionStatus }} o
   */
  recordOutcome(id, o) {
    this.stmt.outcome.run(o.at, o.status, o.consecutiveFailures, o.subscriptionStatus, id);
  }

  counts() {
    const rows = /** @type {{ status: string, n: number }[]} */ (this.stmt.counts.all());
    return { active: Number(rows.find((r) => r.status === 'active')?.n ?? 0), paused: Number(rows.find((r) => r.status === 'paused')?.n ?? 0), disabled: Number(rows.find((r) => r.status === 'disabled')?.n ?? 0) };
  }

  /**
   * Sorted by name; keyset pagination on the name.
   * @param {{ q?: string, status?: string, event?: string }} f
   * @param {{ limit: number, after?: string }} page
   * @returns {SubscriptionRow[]}
   */
  list(f, { limit, after }) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const params = [];
    if (f.q !== undefined) { where.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')"); const like = `%${SubscriptionStore.escapeLike(f.q)}%`; params.push(like, like, like); }
    if (f.status !== undefined) { where.push('status = ?'); params.push(f.status); }
    if (f.event !== undefined) { where.push('EXISTS (SELECT 1 FROM json_each(events) WHERE value = ?)'); params.push(f.event); }
    if (after !== undefined) { where.push('name > ?'); params.push(after); }
    const sql = `SELECT ${SubscriptionStore.COLUMNS} FROM subscriptions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name LIMIT ?`;
    let stmt = this.cache.get(sql);
    if (!stmt) { stmt = this.db.prepare(sql); this.cache.set(sql, stmt); }
    return /** @type {SubscriptionRow[]} */ (stmt.all(...params, limit));
  }

  /** @param {string} s */
  static escapeLike(s) {
    return s.replace(/[\\%_]/g, (c) => `\\${c}`);
  }
}
