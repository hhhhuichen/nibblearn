import type { ModelUsage } from "./types.ts";

export function emptyUsage(): ModelUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(target: ModelUsage, value?: ModelUsage): void {
  if (!value) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += value[key] || 0;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += value.cost[key] || 0;
}
