/** JSON Schemas for the HTTP surface. Semantic checks (URL, patterns, headers) happen in the domain layer. */
export class Schemas {
  static name = { type: 'string', pattern: '^[a-z0-9]+([.\\-_][a-z0-9]+)*$', maxLength: 80 };
  static subId = { type: 'string', pattern: '^sub_[0-9a-f]{16}$' };
  static evtId = { type: 'string', pattern: '^evt_[0-9a-f]{16}$' };
  static intId = { type: 'string', pattern: '^[1-9][0-9]{0,15}$' };
  static description = { type: 'string', maxLength: 500 };
  static url = { type: 'string', minLength: 8, maxLength: 2048 };
  static events = { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 120 } };
  static headers = { type: 'object', maxProperties: 10, additionalProperties: { type: 'string', maxLength: 1024 }, propertyNames: { maxLength: 64 } };
  static eventType = { type: 'string', minLength: 1, maxLength: 120 };
  static status = { type: 'string', enum: ['active', 'paused', 'disabled'] };
  static deliveryStatus = { type: 'string', enum: ['pending', 'running', 'retrying', 'succeeded', 'failed', 'cancelled'] };
  static limit = { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' };
  static iso = { type: 'string', minLength: 20, maxLength: 40 };

  /**
   * @param {string[]} required
   * @param {Record<string, object>} properties
   */
  static body(required, properties) {
    return { type: 'object', additionalProperties: false, required, properties };
  }

  static createSubscription = Schemas.body(['name', 'url', 'events'], { name: Schemas.name, url: Schemas.url, events: Schemas.events, description: Schemas.description, headers: Schemas.headers, enabled: { type: 'boolean' }, ordered: { type: 'boolean' } });
  static patchSubscription = { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: Schemas.name, url: Schemas.url, events: Schemas.events, description: Schemas.description, headers: Schemas.headers, enabled: { type: 'boolean' }, ordered: { type: 'boolean' } } };
  static replay = Schemas.body(['from'], { from: Schemas.iso, to: Schemas.iso });
  static publish = Schemas.body(['type'], { type: Schemas.eventType, data: {}, idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 } });

  static subParams = { type: 'object', properties: { id: Schemas.subId }, required: ['id'] };
  static evtParams = { type: 'object', properties: { id: Schemas.evtId }, required: ['id'] };
  static idParams = { type: 'object', properties: { id: Schemas.intId }, required: ['id'] };

  static subscriptionsQuery = { type: 'object', additionalProperties: false, properties: { q: { type: 'string', minLength: 1, maxLength: 120 }, status: Schemas.status, event: { type: 'string', minLength: 1, maxLength: 120 }, limit: Schemas.limit, cursor: Schemas.name } };
  static eventsQuery = { type: 'object', additionalProperties: false, properties: { type: Schemas.eventType, limit: Schemas.limit, before: Schemas.intId } };
  static deliveriesQuery = { type: 'object', additionalProperties: false, properties: { status: Schemas.deliveryStatus, subscription: Schemas.subId, event: Schemas.evtId, limit: Schemas.limit, before: Schemas.intId } };
}
