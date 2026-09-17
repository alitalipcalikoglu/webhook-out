/**
 * Shared JSDoc typedefs for the webhook-out service. No runtime exports.
 */

/** @typedef {'read'|'write'|'readwrite'|'publish'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 * @property {KeyRole} role
 */

/**
 * Plain values accepted by the `Config` constructor.
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit   Audit service to forward events to; null = off.
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string} [dbBackupDir]
 * @property {ApiKey[]} apiKeys
 * @property {Buffer} secretsKey            32-byte key that encrypts subscriber secrets at rest.
 * @property {boolean} targetAllowHttp
 * @property {boolean} targetAllowPrivate
 * @property {string[]} targetAllowedHosts
 * @property {number[]} retryScheduleSec    Delay before retry n (n = 1..); length + 1 = attempts.
 * @property {number} deliveryTimeoutMs
 * @property {number} workerConcurrency
 * @property {number} subscriptionConcurrencyMax  Cap on one unordered subscription's in-flight deliveries.
 * @property {number} pollMs
 * @property {number} disableAfterFailures  Consecutive dead deliveries that disable a subscription.
 * @property {number} eventRetentionDays
 * @property {number} maxEventBytes
 * @property {number} prevSecretGraceHours
 * @property {number} rateLimitMax
 * @property {number} leaseMs          How long a claimed delivery's lease lasts without a heartbeat.
 * @property {number} heartbeatMs      How often an in-flight delivery's lease is renewed; must be < leaseMs.
 */

/** @typedef {import('./config.js').Config} Config */

/** @typedef {'active'|'paused'|'disabled'} SubscriptionStatus */

/**
 * @typedef {object} SubscriptionRow
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} url
 * @property {string} events               JSON array of patterns.
 * @property {string} headers              JSON object.
 * @property {string} secret_enc           Sealed current secret.
 * @property {string|null} prev_secret_enc Sealed previous secret during the rotation grace.
 * @property {number|null} prev_until
 * @property {SubscriptionStatus} status
 * @property {number} consecutive_failures
 * @property {number|null} last_delivery_at
 * @property {string|null} last_status
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} updated_at
 * @property {number} ordered  0/1 — best-effort ordered delivery (Stage 10); see DeliveryStore#claim.
 */

/**
 * @typedef {object} EventRow
 * @property {number} seq
 * @property {string} id
 * @property {string} type
 * @property {string} data                 JSON.
 * @property {string|null} idem_key
 * @property {string} source
 * @property {string|null} only_subscription  Set for test events: delivered to one subscriber only.
 * @property {number} created_at
 */

/** @typedef {'pending'|'running'|'retrying'|'succeeded'|'failed'|'cancelled'} DeliveryStatus */

/**
 * One event to one subscriber, through every attempt.
 * @typedef {object} DeliveryRow
 * @property {number} id
 * @property {string} event_id
 * @property {string} subscription_id
 * @property {DeliveryStatus} status
 * @property {number} attempt
 * @property {number} max_attempts
 * @property {number|null} next_attempt_at
 * @property {number|null} started_at
 * @property {number|null} finished_at
 * @property {number|null} duration_ms
 * @property {number|null} http_status
 * @property {string|null} response
 * @property {string|null} error
 * @property {string} attempts             JSON array of {@link Attempt}.
 * @property {number} created_at
 * @property {string|null} owner_token     The fencing token of whoever currently holds the lease; null when not `running`.
 * @property {number|null} lease_until     ms since epoch; null when not `running` (or a pre-Stage-6 leftover row).
 */

/**
 * The shape {@link import('./store/delivery-store.js').DeliveryStore#finish} takes — an attempt's
 * outcome already reduced to a terminal or retrying decision.
 * @typedef {object} FinishOutcome
 * @property {'succeeded'|'retrying'|'failed'} status
 * @property {number|null} finishedAt
 * @property {number} durationMs
 * @property {number|null} httpStatus
 * @property {string|null} response
 * @property {string|null} error
 * @property {Attempt[]} attempts
 * @property {number|null} nextAttemptAt
 */

/**
 * @typedef {object} Attempt
 * @property {number} n
 * @property {string} startedAt
 * @property {number} durationMs
 * @property {number|null} httpStatus
 * @property {string|null} error
 */

/**
 * Result of one HTTP attempt.
 * @typedef {object} CallResult
 * @property {number} httpStatus
 * @property {string} response
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

/**
 * The subset of a logger every non-HTTP consumer (`Worker`, `Lifecycle`) actually needs —
 * satisfied both by a real Fastify/pino logger and by `ConsoleLogger` (used when there is no
 * Fastify instance to log through, i.e. the worker-only role).
 * @typedef {object} MinimalLogger
 * @property {(o: object|string, m?: string) => void} info
 * @property {(o: object|string, m?: string) => void} warn
 * @property {(o: object|string, m?: string) => void} error
 * @property {(o: object|string, m?: string) => void} fatal
 * @property {(o: object|string, m?: string) => void} debug
 * @property {(o: object|string, m?: string) => void} trace
 * @property {(bindings: object) => MinimalLogger} child
 */

export {};
