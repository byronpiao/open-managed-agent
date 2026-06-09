/**
 * Minimal Driver event input shape for CMA projections.
 * Vendored subset from mosoo-agent-driver protocol/events + runtime-events.
 */

export interface DriverEventInput {
  readonly kind: string;
  readonly payload: unknown;
  readonly visibility?: string;
}
