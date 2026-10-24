export interface Limits {
  minGapMs: number; readHourly: number; readDaily: number;
  writeHourly: number; writeDaily: number; writeGapSec: number; dmGapSec: number;
}
export const RISK_DEFAULTS: Limits;
export class TrafficError extends Error { code: string }
export function riskSettings(): Limits;
export function createTrafficGuard(options: {
  directory: string;
  transport?: typeof fetch;
  settings?: () => Limits;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
}): {
  fetch: typeof fetch;
  status(): Record<string, unknown>;
  pauseReason(headers: HeadersInit): string | null;
  resume(headers: HeadersInit): Promise<void>;
};
