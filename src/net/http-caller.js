import { CallError, HttpCaller as CoreHttpCaller } from '@atc-web/service-core/http';
import { Signer } from './signer.js';

/** @typedef {import('@atc-web/service-core/http').NetGuard} NetGuard */
/** @typedef {import('../types.js').CallResult} CallResult */

export { CallError };

/**
 * Performs one delivery: SSRF guard, signature with the subscriber's secret(s), delivery headers,
 * pinned address, timeout, bounded response capture. Redirects are not followed. The socket work
 * (pinned-address connect, timeout, bounded response read) is service-core's `HttpCaller.send()`;
 * the signing, headers and always-POST/JSON delivery shape below are this service's own policy.
 */
export class HttpCaller {
  static USER_AGENT = 'atc-webhook-out/1.0';

  /**
   * @param {object} opts
   * @param {NetGuard} opts.guard
   * @param {number} opts.timeoutMs
   * @param {() => number} [opts.now]
   */
  constructor({ guard, timeoutMs, now = Date.now }) {
    this.guard = guard;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  /**
   * @param {{ url: string, headers: Record<string, string>, secrets: string[], body: string, event: { id: string, type: string }, delivery: number, attempt: number, subscription: string }} call
   * @returns {Promise<CallResult>} 2xx outcome; rejects with {@link CallError} otherwise.
   */
  async call({ url, headers: custom, secrets, body, event, delivery, attempt, subscription }) {
    /** @type {import('@atc-web/service-core/http').VettedTarget} */
    let vetted;
    try {
      vetted = await this.guard.resolve(url);
    } catch (err) {
      const e = /** @type {{ code?: string, message: string, retryable?: boolean }} */ (err);
      throw new CallError(e.message, { retryable: e.retryable === true, code: e.code });
    }
    const now = this.now();
    /** @type {Record<string, string>} */
    const headers = {
      ...custom,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      accept: 'application/json, */*;q=0.5',
      'user-agent': HttpCaller.USER_AGENT,
      'x-webhook-id': event.id,
      'x-webhook-event': event.type,
      'x-webhook-delivery': String(delivery),
      'x-webhook-attempt': String(attempt),
      'x-webhook-subscription': subscription,
      'x-webhook-timestamp': new Date(now).toISOString(),
      [Signer.HEADER]: Signer.sign(body, Math.floor(now / 1000), secrets),
    };
    return CoreHttpCaller.send(vetted, 'POST', headers, body, this.timeoutMs, 'receiver');
  }

  /** Whether a failed delivery with this status may succeed later. @param {number} status */
  static isRetryableStatus(status) {
    return CoreHttpCaller.isRetryableStatus(status);
  }
}
