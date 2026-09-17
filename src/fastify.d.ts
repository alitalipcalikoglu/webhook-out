// Type-only augmentation for the request decorators set in api-key-auth.js. No runtime code.
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: import('./types.js').ApiKey;
  }
  interface FastifyContextConfig {
    audit?: import('@atc-web/service-core/audit').AuditRouteConfig;
  }
}
