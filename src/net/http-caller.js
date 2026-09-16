import http from 'node:http';
import https from 'node:https';
import { Signer } from './signer.js';

/** @typedef {import('./net-guard.js').NetGuard} NetGuard */
/** @typedef {import('../types.js').CallResult} CallResult */

export class CallError extends Error {
  /**
   * @param {string} message
   * @param {{ httpStatus?: number|null, response?: string, retryable: boolean, code?: string }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'CallError';
    this.httpStatus = info.httpStatus ?? null;
    this.response = info.response ?? '';
    this.retryable = info.retryable;
    this.code = info.code;
  }
}

/**
 * Performs one delivery: SSRF guard, signature with the subscriber's secret(s), delivery headers,
 * pinned address, timeout, bounded response capture. Redirects are not followed.
 */
export class HttpCaller {
  static USER_AGENT = 'atc-webhook-out/1.0';
  static MAX_RESPONSE = 1024;

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
    /** @type {import('./net-guard.js').VettedTarget} */
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
    return this.#send(vetted, headers, body);
  }

  /**
   * @param {import('./net-guard.js').VettedTarget} target
   * @param {Record<string, string>} headers
   * @param {string} body
   * @returns {Promise<CallResult>}
   */
  #send(target, headers, body) {
    const client = target.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.request(target.url, {
        method: 'POST',
        headers,
        timeout: this.timeoutMs,
        // Pin the vetted address; TLS SNI and the Host header still use the hostname.
        lookup: (_host, opts, cb) => (opts.all
          ? cb(null, [{ address: target.address, family: target.family }])
          : cb(null, target.address, target.family)),
      }, (res) => {
        const status = res.statusCode ?? 0;
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (size < HttpCaller.MAX_RESPONSE) { chunks.push(c); size += c.length; }
        });
        res.on('end', () => {
          const snippet = Buffer.concat(chunks).toString('utf8', 0, HttpCaller.MAX_RESPONSE).replace(/\s+/g, ' ').trim();
          if (status >= 200 && status < 300) return resolve({ httpStatus: status, response: snippet });
          reject(new CallError(`receiver responded ${status}${snippet ? `: ${snippet.slice(0, 200)}` : ''}`, { httpStatus: status, response: snippet, retryable: HttpCaller.isRetryableStatus(status) }));
        });
        res.on('error', (err) => reject(new CallError(`response error: ${err.message}`, { retryable: true })));
      });
      req.on('timeout', () => req.destroy(new CallError(`receiver timed out after ${this.timeoutMs}ms`, { retryable: true, code: 'TIMEOUT' })));
      req.on('error', (err) => reject(err instanceof CallError ? err : new CallError(`request error: ${err.message}`, { retryable: true, code: /** @type {{ code?: string }} */ (err).code })));
      req.end(body);
    });
  }

  /** Whether a failed delivery with this status may succeed later. @param {number} status */
  static isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
}
