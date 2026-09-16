import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** SQLite connection with schema migrations applied on open. */
export class Database {
  /** @type {readonly string[]} */
  static MIGRATIONS = [
    `
    CREATE TABLE subscriptions (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL UNIQUE,
      description          TEXT NOT NULL DEFAULT '',
      url                  TEXT NOT NULL,
      events               TEXT NOT NULL,
      headers              TEXT NOT NULL DEFAULT '{}',
      secret_enc           TEXT NOT NULL,
      prev_secret_enc      TEXT,
      prev_until           INTEGER,
      status               TEXT NOT NULL CHECK (status IN ('active', 'paused', 'disabled')),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_delivery_at     INTEGER,
      last_status          TEXT,
      created_by           TEXT NOT NULL,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
    CREATE INDEX subscriptions_status ON subscriptions (status);

    CREATE TABLE events (
      seq               INTEGER PRIMARY KEY AUTOINCREMENT,
      id                TEXT NOT NULL UNIQUE,
      type              TEXT NOT NULL,
      data              TEXT NOT NULL,
      idem_key          TEXT,
      source            TEXT NOT NULL,
      only_subscription TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX events_idem ON events (source, idem_key) WHERE idem_key IS NOT NULL;
    CREATE INDEX events_type ON events (type, seq DESC);
    CREATE INDEX events_created ON events (created_at);

    CREATE TABLE deliveries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      status          TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retrying', 'succeeded', 'failed', 'cancelled')),
      attempt         INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL,
      next_attempt_at INTEGER,
      started_at      INTEGER,
      finished_at     INTEGER,
      duration_ms     INTEGER,
      http_status     INTEGER,
      response        TEXT,
      error           TEXT,
      attempts        TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE status IN ('pending', 'retrying');
    CREATE INDEX deliveries_subscription ON deliveries (subscription_id, id DESC);
    CREATE INDEX deliveries_event ON deliveries (event_id);
    CREATE INDEX deliveries_status ON deliveries (status, id DESC);
    CREATE INDEX deliveries_created ON deliveries (created_at);
    `,
  ];

  /** @param {string} path File path, or ":memory:". */
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    /** @readonly */
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate() {
    const { user_version: current } = /** @type {{ user_version: number }} */ (this.raw.prepare('PRAGMA user_version').get());
    for (let v = current; v < Database.MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(Database.MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /** @param {string} sql */
  prepare(sql) {
    return this.raw.prepare(sql);
  }

  /**
   * Run `fn` inside a write transaction; rolls back on throw.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** Cheap liveness probe; throws if the connection is unusable. */
  ping() {
    this.raw.prepare('SELECT 1').get();
  }

  close() {
    this.raw.close();
  }
}
