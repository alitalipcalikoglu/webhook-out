import { randomBytes } from 'node:crypto';
import { SecretBox as CoreSecretBox } from '@atc-web/service-core/secrets';

/**
 * AES-256-GCM sealing of subscriber secrets at rest (core's `SecretBox`), plus this service's own
 * `generate()` for a fresh `whsec_`-prefixed secret — that prefix and length are a webhook-out
 * convention, not a cross-cutting one, so it stays local rather than growing core for one consumer.
 */
export class SecretBox extends CoreSecretBox {
  /** A fresh subscriber secret: `whsec_` + 32 random bytes, base64url. */
  static generate() {
    return `whsec_${randomBytes(32).toString('base64url')}`;
  }
}
