import { Application } from './application.js';

// HTTP only: subscription/event/delivery management and read-only stats, no Worker — never claims
// a delivery. See Application's "role" doc for what this changes about readiness/stats.
await Application.fromEnv({ role: 'api' }).start();
