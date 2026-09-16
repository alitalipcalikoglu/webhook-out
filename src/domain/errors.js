/**
 * Domain error with a stable machine-readable code and the HTTP status the API maps it to.
 */
export class WebhookError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    SUBSCRIPTION_NOT_FOUND: 404,
    SUBSCRIPTION_EXISTS: 409,
    EVENT_NOT_FOUND: 404,
    DELIVERY_NOT_FOUND: 404,
    DELIVERY_NOT_CANCELLABLE: 409,
    INVALID_URL: 400,
    INVALID_PATTERN: 400,
    INVALID_HEADER: 400,
    INVALID_EVENT_TYPE: 400,
    INVALID_RANGE: 400,
    EVENT_TOO_LARGE: 413,
    INVALID_CURSOR: 400,
    FORBIDDEN: 403,
  };

  /**
   * @param {keyof typeof WebhookError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'WebhookError';
    this.code = code;
    this.statusCode = WebhookError.STATUS[code];
    this.details = details;
  }
}
