import { WebhookError } from './errors.js';

/**
 * Event type names and the patterns subscriptions use to select them. A type is dot-separated
 * lower-case segments (`order.paid`); a pattern is a type, a prefix wildcard (`order.*`) or `*`.
 */
export class EventMatch {
  static TYPE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
  static PATTERN = /^(\*|[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?:\.\*)?)$/;
  static MAX_PATTERNS = 100;

  /** @param {string} type */
  static assertType(type) {
    if (!EventMatch.TYPE.test(type) || type.length > 120) throw new WebhookError('INVALID_EVENT_TYPE', `event type "${type}" must be dot-separated lower-case segments`);
    return type;
  }

  /**
   * Validate, trim and de-duplicate patterns.
   * @param {string[]} patterns
   */
  static normalize(patterns) {
    const out = [...new Set(patterns.map((p) => p.trim()))];
    if (out.length === 0) throw new WebhookError('INVALID_PATTERN', 'at least one event pattern is required');
    if (out.length > EventMatch.MAX_PATTERNS) throw new WebhookError('INVALID_PATTERN', `at most ${EventMatch.MAX_PATTERNS} patterns`);
    for (const p of out) if (!EventMatch.PATTERN.test(p) || p.length > 120) throw new WebhookError('INVALID_PATTERN', `pattern "${p}" must be an event type, a prefix like "order.*" or "*"`);
    return out.sort();
  }

  /**
   * @param {string} pattern
   * @param {string} type
   */
  static matches(pattern, type) {
    if (pattern === '*') return true;
    if (pattern.endsWith('.*')) { const prefix = pattern.slice(0, -1); return type.startsWith(prefix) && type.length > prefix.length; }
    return pattern === type;
  }

  /**
   * @param {string[]} patterns
   * @param {string} type
   */
  static any(patterns, type) {
    return patterns.some((p) => EventMatch.matches(p, type));
  }
}
