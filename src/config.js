import { ConfigError, EnvReader, parseApiKeys, parseAudit, parseTarget } from '@atc-web/service-core/config';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

  // Stage 6.2: single source of truth for the two shutdown-timer margins, so `application.js`
  // never re-derives this arithmetic by hand (that duplication is exactly how notify's Stage 6.1
  // forceExitMs bug happened). `externalCallCeilingMs < drainMs < forceExitMs` holds unconditionally
  // for any valid DELIVERY_TIMEOUT_MS — the margins are fixed, not operator-configurable — so there
  // is no invalid combination for config validation to reject here; `test/config.test.js` locks the
  // ordering in instead.
  static DRAIN_MARGIN_MS = 5_000;
  static FORCE_EXIT_MARGIN_MS = 10_000;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.apiKeys = v.apiKeys;
    this.secretsKey = v.secretsKey;
    this.targetAllowHttp = v.targetAllowHttp;
    this.targetAllowPrivate = v.targetAllowPrivate;
    this.targetAllowedHosts = v.targetAllowedHosts;
    this.retryScheduleSec = v.retryScheduleSec;
    this.deliveryTimeoutMs = v.deliveryTimeoutMs;
    this.workerConcurrency = v.workerConcurrency;
    this.pollMs = v.pollMs;
    this.disableAfterFailures = v.disableAfterFailures;
    this.eventRetentionDays = v.eventRetentionDays;
    this.maxEventBytes = v.maxEventBytes;
    this.prevSecretGraceHours = v.prevSecretGraceHours;
    this.rateLimitMax = v.rateLimitMax;
    this.leaseMs = v.leaseMs;
    this.heartbeatMs = v.heartbeatMs;
    Object.freeze(this);
  }

  /** The worst-case duration of one external call this process makes — what shutdown timers are sized against. */
  get externalCallCeilingMs() { return this.deliveryTimeoutMs; }

  /** Bound on `Worker#stop()`'s own wait for in-flight deliveries. */
  get drainMs() { return this.externalCallCeilingMs + Config.DRAIN_MARGIN_MS; }

  /** Process-wide force-exit backstop; strictly greater than {@link drainMs}. */
  get forceExitMs() { return this.externalCallCeilingMs + Config.FORCE_EXIT_MARGIN_MS; }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    const secretsKeyHex = r.required('SECRETS_KEY');
    if (!/^[0-9a-fA-F]{64}$/.test(secretsKeyHex)) throw new ConfigError('SECRETS_KEY must be 64 hex characters (32 bytes); generate with: openssl rand -hex 32');

    const target = parseTarget(r);

    const retryScheduleSec = Config.#parseSchedule(r.optional('RETRY_SCHEDULE_SEC') || '60,300,1800,7200,21600,86400');

    // Stage 6: lease ownership. heartbeatMs must stay well under leaseMs — see ratelimit/scheduler's
    // identical validation for the reasoning (a single missed heartbeat must not itself be enough
    // to lose the lease).
    const leaseMs = r.integer('LEASE_MS', 30_000, { min: 2_000, max: 300_000 });
    const heartbeatMs = r.integer('HEARTBEAT_MS', 10_000, { min: 250 });
    if (heartbeatMs >= leaseMs) throw new ConfigError('HEARTBEAT_MS must be less than LEASE_MS');

    return new Config({
      port: r.integer('PORT', 3009, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 65_536, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/webhook-out.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys: Config.#parseApiKeys(r.required('WEBHOOK_API_KEYS')),
      secretsKey: Buffer.from(secretsKeyHex, 'hex'),
      targetAllowHttp: target.allowHttp,
      targetAllowPrivate: target.allowPrivate,
      targetAllowedHosts: target.allowedHosts,
      retryScheduleSec,
      deliveryTimeoutMs: r.integer('DELIVERY_TIMEOUT_MS', 15_000, { min: 1_000, max: 120_000 }),
      workerConcurrency: r.integer('WORKER_CONCURRENCY', 16, { min: 1, max: 128 }),
      pollMs: r.integer('POLL_MS', 1_000, { min: 100, max: 60_000 }),
      disableAfterFailures: r.integer('DISABLE_AFTER_FAILURES', 10, { min: 1 }),
      eventRetentionDays: r.integer('EVENT_RETENTION_DAYS', 30, { min: 1 }),
      maxEventBytes: r.integer('MAX_EVENT_BYTES', 65_536, { min: 256 }),
      prevSecretGraceHours: r.integer('PREV_SECRET_GRACE_HOURS', 24, { min: 0, max: 720 }),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 1_200, { min: 1 }),
      leaseMs,
      heartbeatMs,
    });
  }

  /**
   * Parse `id:secret[:role]`. Role defaults to `readwrite`; `publish` may only post events.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'WEBHOOK_API_KEYS', { roles: ['read', 'write', 'readwrite', 'publish'], minSecretLength: Config.MIN_SECRET_LENGTH, roleErrorMessage: () => 'must be read, write, readwrite or publish' })
      .map(({ id, secret, role }) => ({ id, secret, role: /** @type {KeyRole} */ (role) }));
  }

  /**
   * Comma-separated delays in seconds before retry 1, 2, 3, …; must not decrease.
   * @param {string} raw
   */
  static #parseSchedule(raw) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      if (!/^\d+$/.test(s)) throw new ConfigError(`RETRY_SCHEDULE_SEC entry "${s}" must be an integer`);
      return Number(s);
    });
    if (list.length > 50) throw new ConfigError('RETRY_SCHEDULE_SEC may list at most 50 delays');
    for (let i = 0; i < list.length; i++) {
      if (list[i] < 1) throw new ConfigError('RETRY_SCHEDULE_SEC delays must be >= 1');
      if (i > 0 && list[i] < list[i - 1]) throw new ConfigError('RETRY_SCHEDULE_SEC delays must not decrease');
    }
    return list;
  }
}
