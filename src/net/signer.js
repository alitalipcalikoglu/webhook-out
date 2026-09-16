import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 delivery signing. Header value is `t=<unix seconds>,v1=<hex>[,v1=<hex>]` where
 * `v1 = HMAC(secret, "<t>.<raw body>")`. During a secret rotation the previous secret signs a
 * second `v1` so receivers can switch at their own pace. Receivers use {@link verify}.
 */
export class Signer {
  static HEADER = 'x-webhook-signature';

  /**
   * @param {string} body
   * @param {number} timestamp Unix seconds.
   * @param {string[]} secrets Current first, then the previous one while it is still valid.
   */
  static sign(body, timestamp, secrets) {
    return [`t=${timestamp}`, ...secrets.map((s) => `v1=${Signer.digest(s, body, timestamp).toString('hex')}`)].join(',');
  }

  /**
   * @param {string} secret
   * @param {string} body
   * @param {string} header
   * @param {{ toleranceSec?: number, now?: number }} [opts]
   */
  static verify(secret, body, header, { toleranceSec = 300, now = Date.now() } = {}) {
    const parts = header.split(',');
    const t = Number(parts[0]?.startsWith('t=') ? parts[0].slice(2) : NaN);
    if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > toleranceSec) return false;
    const expected = Signer.digest(secret, body, t);
    return parts.slice(1).some((p) => {
      if (!/^v1=[0-9a-f]{64}$/.test(p)) return false;
      const given = Buffer.from(p.slice(3), 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  }

  /** @param {string} secret @param {string} body @param {number} t */
  static digest(secret, body, t) {
    return createHmac('sha256', secret).update(`${t}.${body}`).digest();
  }
}
