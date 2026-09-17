import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/service-core/auth';
import { WebhookError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/**
 * Bearer API-key authentication with read/write/publish roles. Thin wrapper over service-core's
 * `ApiKeyAuth`: `GRANTS` (write also satisfies publish) is this service's own authorization
 * policy, passed to core's `require()` as data — core does not know what "publish" means.
 */
export class ApiKeyAuth {
  /** Which roles satisfy each need. `publish` keys may only post events; write keys can do that too. */
  static GRANTS = /** @type {Record<'read'|'write'|'publish', readonly string[]>} */ ({ read: ['read', 'readwrite'], write: ['write', 'readwrite'], publish: ['publish', 'write', 'readwrite'] });

  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys);
  }

  /** Fastify `onRequest` hook. */
  get hook() {
    return this.core.hook;
  }

  /**
   * Route-level guard on role.
   * @param {'read'|'write'|'publish'} need
   */
  static require(need) {
    return CoreApiKeyAuth.require(need, {
      roleOf: (request) => /** @type {any} */ (request).apiKey?.role,
      makeError: (n) => new WebhookError('FORBIDDEN', `this API key has no ${n} access`),
      grants: ApiKeyAuth.GRANTS,
    });
  }

  /**
   * @param {string} secret Presented secret.
   * @returns {ApiKey|undefined} Matching key.
   */
  identify(secret) {
    return /** @type {ApiKey|undefined} */ (/** @type {any} */ (this.core.identify(secret)));
  }
}
