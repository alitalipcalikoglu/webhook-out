/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
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
    Object.freeze(this);
  }

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

    const targetAllowPrivate = r.boolean('TARGET_ALLOW_PRIVATE', false);
    const targetAllowedHosts = r.list('TARGET_ALLOWED_HOSTS').map((h) => h.toLowerCase());
    if (targetAllowPrivate && targetAllowedHosts.length === 0) throw new ConfigError('TARGET_ALLOWED_HOSTS is required when TARGET_ALLOW_PRIVATE is true');

    const retryScheduleSec = Config.#parseSchedule(r.optional('RETRY_SCHEDULE_SEC') || '60,300,1800,7200,21600,86400');

    return new Config({
      port: r.integer('PORT', 3009, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      bodyLimit: r.integer('BODY_LIMIT', 65_536, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/webhook-out.db',
      apiKeys: Config.#parseApiKeys(r.required('WEBHOOK_API_KEYS')),
      secretsKey: Buffer.from(secretsKeyHex, 'hex'),
      targetAllowHttp: r.boolean('TARGET_ALLOW_HTTP', false),
      targetAllowPrivate,
      targetAllowedHosts,
      retryScheduleSec,
      deliveryTimeoutMs: r.integer('DELIVERY_TIMEOUT_MS', 15_000, { min: 1_000, max: 120_000 }),
      workerConcurrency: r.integer('WORKER_CONCURRENCY', 16, { min: 1, max: 128 }),
      pollMs: r.integer('POLL_MS', 1_000, { min: 100, max: 60_000 }),
      disableAfterFailures: r.integer('DISABLE_AFTER_FAILURES', 10, { min: 1 }),
      eventRetentionDays: r.integer('EVENT_RETENTION_DAYS', 30, { min: 1 }),
      maxEventBytes: r.integer('MAX_EVENT_BYTES', 65_536, { min: 256 }),
      prevSecretGraceHours: r.integer('PREV_SECRET_GRACE_HOURS', 24, { min: 0, max: 720 }),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 1_200, { min: 1 }),
    });
  }

  /**
   * Parse `id:secret[:role]`. Role defaults to `readwrite`; `publish` may only post events.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    const keys = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const parts = entry.split(':');
      if (parts.length < 2 || parts.length > 3) throw new ConfigError(`WEBHOOK_API_KEYS entry "${entry.slice(0, 8)}…" must be id:secret[:role]`);
      const [id, secret, role = 'readwrite'] = parts;
      if (!Config.ID_PATTERN.test(id)) throw new ConfigError(`WEBHOOK_API_KEYS id "${id}" must match [A-Za-z0-9_-]{1,64}`);
      if (secret.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`WEBHOOK_API_KEYS secret for "${id}" must be at least ${Config.MIN_SECRET_LENGTH} characters`);
      if (role !== 'read' && role !== 'write' && role !== 'readwrite' && role !== 'publish') throw new ConfigError(`WEBHOOK_API_KEYS role for "${id}" must be read, write, readwrite or publish`);
      return { id, secret, role: /** @type {KeyRole} */ (role) };
    });
    if (keys.length === 0) throw new ConfigError('WEBHOOK_API_KEYS must contain at least one key');
    if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new ConfigError('WEBHOOK_API_KEYS ids must be unique');
    if (new Set(keys.map((k) => k.secret)).size !== keys.length) throw new ConfigError('WEBHOOK_API_KEYS secrets must be unique');
    return keys;
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

/** Typed accessors over a raw environment map. */
class EnvReader {
  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    this.env = env;
  }

  /** @param {string} name */
  optional(name) {
    return this.env[name]?.trim() ?? '';
  }

  /** @param {string} name */
  required(name) {
    const v = this.optional(name);
    if (v === '') throw new ConfigError(`${name} is required`);
    return v;
  }

  /** Comma-separated list. @param {string} name */
  list(name) {
    return this.optional(name).split(',').map((s) => s.trim()).filter(Boolean);
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @param {{ min?: number, max?: number }} [range]
   */
  integer(name, fallback, range = {}) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
    const n = Number(raw);
    if (range.min !== undefined && n < range.min) throw new ConfigError(`${name} must be >= ${range.min}`);
    if (range.max !== undefined && n > range.max) throw new ConfigError(`${name} must be <= ${range.max}`);
    return n;
  }

  /**
   * @param {string} name
   * @param {boolean} fallback
   */
  boolean(name, fallback) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${name} must be true or false, got "${raw}"`);
  }
}
