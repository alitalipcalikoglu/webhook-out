import { randomBytes } from 'node:crypto';
import { WebhookError } from './errors.js';
import { EventMatch } from './event-match.js';

/** @typedef {import('../types.js').EventRow} EventRow */
/** @typedef {import('../types.js').DeliveryRow} DeliveryRow */
/** @typedef {import('../types.js').SubscriptionRow} SubscriptionRow */

/**
 * Publishing and fan-out: one event becomes one delivery per matching subscription, in the same
 * transaction, so a publish that returns 202 is already queued for everyone. Also test events,
 * replays and redeliveries.
 */
export class EventService {
  static TEST_TYPE = 'webhook.test';
  static REPLAY_BATCH = 1_000;

  /**
   * @param {object} deps
   * @param {import('../db.js').Database} deps.db
   * @param {import('../store/event-store.js').EventStore} deps.events
   * @param {import('../store/delivery-store.js').DeliveryStore} deps.deliveries
   * @param {import('../store/subscription-store.js').SubscriptionStore} deps.subscriptions
   * @param {{ maxEventBytes: number, retryScheduleSec: number[] }} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ db, events, deliveries, subscriptions, options, now = Date.now }) {
    this.db = db;
    this.events = events;
    this.deliveries = deliveries;
    this.subscriptions = subscriptions;
    this.options = options;
    this.now = now;
  }

  get maxAttempts() {
    return this.options.retryScheduleSec.length + 1;
  }

  /**
   * Publish one event. With an idempotency key, a repeat from the same source returns the
   * original event and queues nothing new.
   * @param {{ type: string, data: unknown, idempotencyKey?: string }} input
   * @param {string} source
   * @returns {{ event: EventRow, deliveries: DeliveryRow[], duplicate: boolean }}
   */
  publish(input, source) {
    const type = EventMatch.assertType(input.type);
    const data = JSON.stringify(input.data ?? null);
    const bytes = Buffer.byteLength(data);
    if (bytes > this.options.maxEventBytes) throw new WebhookError('EVENT_TOO_LARGE', `event data is ${bytes} bytes, limit ${this.options.maxEventBytes}`);
    return this.db.transaction(() => {
      if (input.idempotencyKey) {
        const existing = this.events.byIdempotencyKey(source, input.idempotencyKey);
        if (existing) return { event: existing, deliveries: this.deliveries.forEvent(existing.id), duplicate: true };
      }
      const now = this.now();
      let event;
      try {
        event = this.events.insert({ id: EventService.newId(), type, data, idem_key: input.idempotencyKey ?? null, source, only_subscription: null, created_at: now });
      } catch (err) {
        // Belt and braces: the check-then-insert above already can't race across connections (this
        // whole method runs inside one BEGIN IMMEDIATE transaction, so a concurrent publish with
        // the same key blocks until this one commits, then sees the row on its own check). This
        // only fires if that invariant is ever broken elsewhere — return the existing event instead
        // of a raw constraint error surfacing as 500.
        if (input.idempotencyKey && EventService.#isUniqueViolation(err)) {
          const existing = this.events.byIdempotencyKey(source, input.idempotencyKey);
          if (existing) return { event: existing, deliveries: this.deliveries.forEvent(existing.id), duplicate: true };
        }
        throw err;
      }
      const targets = this.subscriptions.active().filter((s) => EventMatch.any(JSON.parse(s.events), type));
      return { event, deliveries: targets.map((s) => this.#queue(event, s, now)), duplicate: false };
    });
  }

  /**
   * A synthetic `webhook.test` event delivered to one subscription only, whatever its patterns
   * or status (a paused subscription still gets it queued; it goes out once resumed).
   * @param {string} subscriptionId
   * @param {string} source
   */
  test(subscriptionId, source) {
    const sub = this.subscriptions.require(subscriptionId);
    return this.db.transaction(() => {
      const now = this.now();
      const event = this.events.insert({ id: EventService.newId(), type: EventService.TEST_TYPE, data: JSON.stringify({ subscription: sub.id, name: sub.name, at: new Date(now).toISOString() }), idem_key: null, source, only_subscription: sub.id, created_at: now });
      return { event, delivery: this.#queue(event, sub, now) };
    });
  }

  /**
   * Queue every matching event of a time window again for one subscription: after downtime on
   * the receiver's side, or after a subscription was created late. Existing deliveries are not
   * touched; the receiver sees repeated event ids and must de-duplicate.
   * @param {string} subscriptionId
   * @param {{ from: number, to?: number }} window  `to` defaults to now.
   */
  replay(subscriptionId, { from, to = this.now() }) {
    const sub = this.subscriptions.require(subscriptionId);
    if (to <= from) throw new WebhookError('INVALID_RANGE', 'to must be after from');
    const patterns = /** @type {string[]} */ (JSON.parse(sub.events));
    return this.db.transaction(() => {
      const now = this.now();
      let queued = 0;
      let cursor = from;
      for (;;) {
        const batch = this.events.range(cursor, to, EventService.REPLAY_BATCH);
        for (const e of batch) if (EventMatch.any(patterns, e.type)) { this.#queue(e, sub, now); queued++; }
        if (batch.length < EventService.REPLAY_BATCH) break;
        cursor = batch[batch.length - 1].created_at;
        if (cursor === from) break; // ponytail: a window with 1 000+ events in the same millisecond stops here
      }
      return { queued };
    });
  }

  /**
   * A fresh delivery of the same event to the same subscriber, e.g. after fixing the receiver.
   * @param {number} deliveryId
   */
  redeliver(deliveryId) {
    const d = this.delivery(deliveryId);
    const sub = this.subscriptions.require(d.subscription_id);
    const event = this.events.require(d.event_id);
    return this.#queue(event, sub, this.now());
  }

  /** @param {number} id */
  delivery(id) {
    const row = this.deliveries.get(id);
    if (!row) throw new WebhookError('DELIVERY_NOT_FOUND', `delivery ${id} not found`);
    return row;
  }

  /**
   * Cancel a queued or retrying delivery. A running attempt cannot be interrupted.
   * @param {number} id
   */
  cancel(id) {
    const row = this.delivery(id);
    if (!this.deliveries.cancel(id, 'cancelled by operator', this.now())) throw new WebhookError('DELIVERY_NOT_CANCELLABLE', `delivery ${id} is ${row.status}; only pending and retrying deliveries can be cancelled`);
    return /** @type {DeliveryRow} */ (this.deliveries.get(id));
  }

  /**
   * Delay before the retry that follows attempt number `attempt` (1-based), or null when the
   * schedule is exhausted.
   * @param {number} attempt
   */
  retryDelayMs(attempt) {
    const sec = this.options.retryScheduleSec[attempt - 1];
    return sec === undefined ? null : sec * 1000;
  }

  /**
   * @param {EventRow} event
   * @param {SubscriptionRow} sub
   * @param {number} now
   */
  #queue(event, sub, now) {
    return this.deliveries.insert({ eventId: event.id, subscriptionId: sub.id, maxAttempts: this.maxAttempts, nextAttemptAt: now }, now);
  }

  static newId() {
    return `evt_${randomBytes(8).toString('hex')}`;
  }

  /** @param {unknown} err */
  static #isUniqueViolation(err) {
    return /** @type {{ code?: string, message?: string }} */ (err).code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(/** @type {{ message?: string }} */ (err).message ?? '');
  }
}
