/** @typedef {import('../types.js').SubscriptionRow} SubscriptionRow */
/** @typedef {import('../types.js').EventRow} EventRow */
/** @typedef {import('../types.js').DeliveryRow} DeliveryRow */

/** Response shapes. Secrets never appear here; `create` and `rotate` return them separately, once. */
export class Views {
  /** @param {number|null} t */
  static iso(t) {
    return t === null ? null : new Date(Number(t)).toISOString();
  }

  /** @param {SubscriptionRow} s */
  static subscription(s) {
    return {
      id: s.id, name: s.name, description: s.description, url: s.url, events: /** @type {string[]} */ (JSON.parse(s.events)), headers: JSON.parse(s.headers),
      status: s.status, consecutiveFailures: Number(s.consecutive_failures), lastDeliveryAt: Views.iso(s.last_delivery_at), lastStatus: s.last_status,
      secretRotatedUntil: Views.iso(s.prev_until), createdBy: s.created_by, createdAt: Views.iso(s.created_at), updatedAt: Views.iso(s.updated_at),
    };
  }

  /** @param {EventRow} e */
  static event(e) {
    return { id: e.id, type: e.type, data: JSON.parse(e.data), idempotencyKey: e.idem_key, source: e.source, test: e.only_subscription !== null, createdAt: Views.iso(e.created_at) };
  }

  /** @param {DeliveryRow} d */
  static delivery(d) {
    return {
      id: Number(d.id), eventId: d.event_id, subscriptionId: d.subscription_id, status: d.status,
      attempt: Number(d.attempt), maxAttempts: Number(d.max_attempts), nextAttemptAt: Views.iso(d.next_attempt_at),
      startedAt: Views.iso(d.started_at), finishedAt: Views.iso(d.finished_at), durationMs: d.duration_ms === null ? null : Number(d.duration_ms),
      httpStatus: d.http_status === null ? null : Number(d.http_status), response: d.response, error: d.error,
      attempts: JSON.parse(d.attempts), createdAt: Views.iso(d.created_at),
    };
  }
}
