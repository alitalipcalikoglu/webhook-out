import { createHash, timingSafeEqual } from 'node:crypto';
import { WebhookError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/**
 * Bearer API-key authentication with read/write/publish roles. Every
 * configured key is compared in constant time so timing does not reveal whether, or which, key
 * matched.
 */
export class ApiKeyAuth {
  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.apiKeys = apiKeys;
  }

  /**
   * Fastify `onRequest` hook. Arrow property so it can be passed directly to `addHook`.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   */
  hook = async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const key = secret ? this.identify(secret) : undefined;
    if (!key) {
      reply.header('www-authenticate', 'Bearer');
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid API key' } });
    }
    request.apiKey = key;
  };

  /** Which roles satisfy each need. `publish` keys may only post events; write keys can do that too. */
  static GRANTS = /** @type {Record<'read'|'write'|'publish', readonly string[]>} */ ({ read: ['read', 'readwrite'], write: ['write', 'readwrite'], publish: ['publish', 'write', 'readwrite'] });

  /**
   * Route-level guard on role.
   * @param {'read'|'write'|'publish'} need
   */
  static require(need) {
    /** @param {import('fastify').FastifyRequest} request */
    return async (request) => {
      if (!ApiKeyAuth.GRANTS[need].includes(request.apiKey.role)) throw new WebhookError('FORBIDDEN', `this API key has no ${need} access`);
    };
  }

  /**
   * @param {string} secret Presented secret.
   * @returns {ApiKey|undefined} Matching key.
   */
  identify(secret) {
    /** @type {ApiKey|undefined} */
    let matched;
    for (const key of this.apiKeys) {
      if (ApiKeyAuth.#secretsEqual(secret, key.secret)) matched = key;
    }
    return matched;
  }

  /**
   * Constant-time comparison independent of input length.
   * @param {string} a
   * @param {string} b
   */
  static #secretsEqual(a, b) {
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  }
}
