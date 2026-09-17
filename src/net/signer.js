import { Signer as CoreSigner } from '@atc-web/service-core/http';

/**
 * HMAC-SHA256 delivery signing. Header value is `t=<unix seconds>,v1=<hex>[,v1=<hex>]` where
 * `v1 = HMAC(secret, "<t>.<raw body>")`. During a secret rotation the previous secret signs a
 * second `v1` so receivers can switch at their own pace. Receivers use {@link verify}.
 *
 * Thin wrapper over service-core's `Signer`: `sign()` already matches core's `secrets[]` shape
 * exactly. `verify()` here still takes one secret at a time (this service's own original shape —
 * a receiver checks its own current secret against the header) rather than core's `secrets[]`
 * (which checks whether *any* of several secrets matches); wrapping the one secret in a
 * single-element array reuses core's digest/timing-safe-compare work without changing the call.
 */
export class Signer {
  static HEADER = 'x-webhook-signature';

  /**
   * @param {string} body
   * @param {number} timestamp Unix seconds.
   * @param {string[]} secrets Current first, then the previous one while it is still valid.
   */
  static sign(body, timestamp, secrets) {
    return CoreSigner.sign(body, timestamp, secrets);
  }

  /**
   * @param {string} secret
   * @param {string} body
   * @param {string} header
   * @param {{ toleranceSec?: number, now?: number }} [opts]
   */
  static verify(secret, body, header, opts) {
    return CoreSigner.verify([secret], body, header, opts);
  }

  /** @param {string} secret @param {string} body @param {number} t */
  static digest(secret, body, t) {
    return CoreSigner.digest(secret, body, t);
  }
}
