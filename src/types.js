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
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {ApiKey[]} apiKeys
 * @property {Buffer} secretsKey            32-byte key that encrypts subscriber secrets at rest.
 * @property {boolean} targetAllowHttp
 * @property {boolean} targetAllowPrivate
 * @property {string[]} targetAllowedHosts
 * @property {number[]} retryScheduleSec    Delay before retry n (n = 1..); length + 1 = attempts.
 * @property {number} deliveryTimeoutMs
 * @property {number} workerConcurrency
 * @property {number} pollMs
 * @property {number} disableAfterFailures  Consecutive dead deliveries that disable a subscription.
 * @property {number} eventRetentionDays
 * @property {number} maxEventBytes
 * @property {number} prevSecretGraceHours
 * @property {number} rateLimitMax
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

export {};
