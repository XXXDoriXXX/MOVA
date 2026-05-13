/**
 * Domain events that BillingService listens for.
 *
 * Why event-driven instead of direct dependency:
 *   - Auth module shouldn't know about billing details (decoupling).
 *   - When future modules (e.g. admin tooling) need to create subscriptions
 *     for other reasons, they just emit the same event.
 *   - Easier to add side-effects (welcome email, analytics) without growing
 *     the auth service.
 */

export const USER_REGISTERED_EVENT = 'user.registered';

export interface UserRegisteredPayload {
  userId: string;
  email: string;
  registeredAt: string; // ISO 8601 UTC
}
