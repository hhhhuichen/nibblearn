import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/store.ts";
import { ensureDirectory } from "../src/files.ts";
import type { Material, ModelRunner, ModelUsage, Plan } from "../src/types.ts";

export async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nibblearn-test-"));
  const home = path.join(root, "state"), outputDir = await ensureDirectory(path.join(root, "output"));
  const store = new Store(home);
  const plan: Plan = { schemaVersion: 1, id: "plan-demo", revision: 1, title: "任意主题", topic: "摄影", goal: "理解曝光并能实践", background: "初学者",
    focus: "不需要器材推荐", noteStyle: "概念、例子与自测", language: "zh-CN", outputDir,
    allowModelSupplement: true, consentModelTransfer: true, references: [] };
  await store.savePlan(plan); await store.selectPlan(plan.id);
  const material = await store.saveMaterial({ schemaVersion: 1, kind: "imported-subtitle", title: "示例课程", author: "示例作者", language: "zh-CN",
    segments: [{ start: 0, end: 5, text: "光圈决定进光量，也影响景深。" }, { start: 5, end: 10, text: "快门时间影响运动模糊。" }], warnings: ["仅有字幕"], fetchedAt: new Date().toISOString() });
  return { root, home, outputDir, store, plan, material, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
export const usage: ModelUsage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } };
export function fakeModel(log: string[] = []): ModelRunner {
  return async request => {
    log.push(request.prompt);
    const input = JSON.parse(request.prompt) as { plan: { topic: string }; segments: { index: number; text: string }[] };
    return { text: JSON.stringify({ overview: `围绕${input.plan.topic}整理`, points: input.segments.map(s => ({ heading: `知识点${s.index}`, explanation: s.text, evidence: [s.index] })),
      supplements: [{ text: "这是模型补充，尚未检索核验。", referenceIds: [] }], questions: ["你能解释其适用条件吗？"], caveats: ["需要结合原视频核对。"] }), usage };
  };
}
export function materialWith(segments: Material["segments"]): Material {
  return { schemaVersion: 1, id: "material-test", kind: "imported-subtitle", title: "示例", author: "示例", language: "zh-CN", segments, fetchedAt: new Date().toISOString(), warnings: [] };
}
export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}
