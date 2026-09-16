import { randomBytes } from 'node:crypto';
import { SecretBox } from '../crypto/secret-box.js';
import { WebhookError } from './errors.js';
import { EventMatch } from './event-match.js';

/** @typedef {import('../types.js').SubscriptionRow} SubscriptionRow */
/** @typedef {import('../types.js').SubscriptionStatus} SubscriptionStatus */

/**
 * @typedef {object} SubscriptionInput
 * @property {string} name
 * @property {string} url
 * @property {string[]} events
 * @property {string} [description]
 * @property {Record<string, string>} [headers]
 * @property {boolean} [enabled]
 */

/** Subscription lifecycle: validation, secrets (sealed at rest), rotation, pause and resume. */
export class SubscriptionService {
  static MAX_HEADERS = 10;

  /**
   * @param {object} deps
   * @param {import('../store/subscription-store.js').SubscriptionStore} deps.subscriptions
   * @param {import('../net/net-guard.js').NetGuard} deps.guard
   * @param {SecretBox} deps.box
   * @param {{ prevSecretGraceHours: number }} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ subscriptions, guard, box, options, now = Date.now }) {
    this.subscriptions = subscriptions;
    this.guard = guard;
    this.box = box;
    this.options = options;
    this.now = now;
  }

  /**
   * @param {SubscriptionInput} input
   * @param {string} actor
   * @returns {{ row: SubscriptionRow, secret: string }} The secret is shown once.
   */
  create(input, actor) {
    if (this.subscriptions.byName(input.name)) throw new WebhookError('SUBSCRIPTION_EXISTS', `subscription "${input.name}" already exists`);
    const now = this.now();
    const secret = SecretBox.generate();
    /** @type {SubscriptionRow} */
    const row = {
      id: `sub_${randomBytes(8).toString('hex')}`,
      name: input.name,
      description: input.description ?? '',
      url: this.#url(input.url),
      events: JSON.stringify(EventMatch.normalize(input.events)),
      headers: JSON.stringify(SubscriptionService.#headers(input.headers)),
      secret_enc: this.box.seal(secret),
      prev_secret_enc: null,
      prev_until: null,
      status: input.enabled === false ? 'paused' : 'active',
      consecutive_failures: 0,
      last_delivery_at: null,
      last_status: null,
      created_by: actor,
      created_at: now,
      updated_at: now,
    };
    return { row: this.subscriptions.insert(row), secret };
  }

  /** @param {string} id */
  get(id) {
    return this.subscriptions.require(id);
  }

  /**
   * @param {{ q?: string, status?: string, event?: string }} filter
   * @param {{ limit: number, cursor?: string }} page
   */
  list(filter, { limit, cursor }) {
    const rows = this.subscriptions.list(filter, { limit: limit + 1, after: cursor });
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].name : null };
  }

  /**
   * Partial update. `enabled: true` resumes (also from the automatic `disabled` state and resets
   * the failure counter); `enabled: false` pauses.
   * @param {string} id
   * @param {Partial<SubscriptionInput>} patch
   */
  update(id, patch) {
    const row = this.subscriptions.require(id);
    if (patch.name !== undefined && patch.name !== row.name && this.subscriptions.byName(patch.name)) throw new WebhookError('SUBSCRIPTION_EXISTS', `subscription "${patch.name}" already exists`);
    /** @type {SubscriptionStatus} */
    let status = row.status;
    let failures = row.consecutive_failures;
    if (patch.enabled === true && row.status !== 'active') { status = 'active'; failures = 0; }
    if (patch.enabled === false) status = 'paused';
    return this.subscriptions.update({
      ...row,
      name: patch.name ?? row.name,
      description: patch.description ?? row.description,
      url: patch.url === undefined ? row.url : this.#url(patch.url),
      events: patch.events === undefined ? row.events : JSON.stringify(EventMatch.normalize(patch.events)),
      headers: patch.headers === undefined ? row.headers : JSON.stringify(SubscriptionService.#headers(patch.headers)),
      status,
      consecutive_failures: failures,
      updated_at: this.now(),
    });
  }

  /** Deletes the subscription and, by cascade, its deliveries. @param {string} id */
  remove(id) {
    if (!this.subscriptions.delete(id)) throw new WebhookError('SUBSCRIPTION_NOT_FOUND', `subscription "${id}" not found`);
  }

  /**
   * New secret now; the previous one keeps signing a second `v1` for the grace period.
   * @param {string} id
   * @returns {{ row: SubscriptionRow, secret: string, previousValidUntil: string|null }}
   */
  rotate(id) {
    const row = this.subscriptions.require(id);
    const now = this.now();
    const secret = SecretBox.generate();
    const grace = this.options.prevSecretGraceHours * 3_600_000;
    const updated = this.subscriptions.update({ ...row, secret_enc: this.box.seal(secret), prev_secret_enc: grace ? row.secret_enc : null, prev_until: grace ? now + grace : null, updated_at: now });
    return { row: updated, secret, previousValidUntil: updated.prev_until === null ? null : new Date(updated.prev_until).toISOString() };
  }

  /**
   * Secrets to sign with: the current one, plus the previous one while its grace lasts.
   * @param {SubscriptionRow} row
   */
  signingSecrets(row) {
    const out = [this.box.open(row.secret_enc)];
    if (row.prev_secret_enc && row.prev_until !== null && row.prev_until > this.now()) out.push(this.box.open(row.prev_secret_enc));
    return out;
  }

  /** @param {string} raw */
  #url(raw) {
    try {
      return this.guard.check(raw).href;
    } catch (err) {
      throw new WebhookError('INVALID_URL', /** @type {Error} */ (err).message);
    }
  }

  /** @param {Record<string, string>|undefined} h */
  static #headers(h) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [name, value] of Object.entries(h ?? {})) {
      const lower = name.toLowerCase();
      if (!/^x-[a-z0-9-]{1,60}$/.test(lower) || lower.startsWith('x-webhook-')) throw new WebhookError('INVALID_HEADER', `header "${name}" is not allowed; only custom X-* headers can be set`);
      if (typeof value !== 'string' || value.length > 1024 || !/^[\x20-\x7e]*$/.test(value)) throw new WebhookError('INVALID_HEADER', `header "${name}" must be printable ASCII up to 1024 characters`);
      out[lower] = value;
    }
    if (Object.keys(out).length > SubscriptionService.MAX_HEADERS) throw new WebhookError('INVALID_HEADER', `at most ${SubscriptionService.MAX_HEADERS} headers`);
    return out;
  }
}
