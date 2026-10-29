import * as fs from "node:fs/promises";
import path from "node:path";
import { assertDirectory, readText } from "./files.ts";
import { LearnError } from "./types.ts";
import { id, object, parseJson, text, validatePlan } from "./validate.ts";

export interface StatusOptions {
  /** Explicit local directory; never infer a different host's storage location. */
  home: string;
  maxDrafts: number;
  maxScan: number;
}
export type LearningStatus = {
  state: "ready" | "not-configured";
  plan: { id: string; revision: number; title: string } | null;
  drafts: { id: string; title: string; kind: "material" | "course" | "tutorial" | "practice";
    planRevision: number; createdAt: string; published: boolean }[];
  totalDrafts: number;
  hasMore: boolean;
};

/** Validate operator-supplied limits without reading or creating any directory. */
export function validateStatusOptions(options: StatusOptions): void {
  if (typeof options.home !== "string" || !path.isAbsolute(options.home) || options.home.includes("\0")) {
    throw new LearnError("INVALID_STATUS_CONFIG", "状态读取必须显式指定绝对数据目录，不自动查找其他宿主的数据。");
  }
  if (!Number.isSafeInteger(options.maxDrafts) || options.maxDrafts < 1 || options.maxDrafts > 50
    || !Number.isSafeInteger(options.maxScan) || options.maxScan < options.maxDrafts || options.maxScan > 10000) {
    throw new LearnError("INVALID_STATUS_CONFIG", "maxDrafts 必须为 1–50；maxScan 必须不小于 maxDrafts 且不超过 10000。");
  }
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
async function directoryExists(directory: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  try { await assertDirectory(directory); }
  catch (error) { signal?.throwIfAborted(); if (missing(error)) return false; throw error; }
  signal?.throwIfAborted();
  return true;
}
async function record(file: string, limit: number, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  signal?.throwIfAborted();
  try {
    // Store.read() may mkdir. This independent view only opens existing regular files.
    await assertDirectory(path.dirname(file));
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new LearnError("UNSAFE_STATUS_FILE", "状态文件不能是链接或非普通文件。");
    }
    const raw = await readText(file, limit);
    signal?.throwIfAborted();
    return object(parseJson(raw));
  } catch (error) { signal?.throwIfAborted(); if (missing(error)) return undefined; throw error; }
}

/**
 * Read a bounded metadata snapshot without Store.init(), credential access or writes.
 * Checks cancellation between bounded file reads. No atomic cross-file snapshot is promised;
 * concurrent plan switches are detected, while draft metadata reflects each file's read time.
 * @param options Explicit authorized data directory and operator-owned limits.
 * @param signal Cancels scanning; no partial result is returned after cancellation.
 */
export async function readLearningStatus(options: StatusOptions, signal?: AbortSignal): Promise<LearningStatus> {
  validateStatusOptions(options);
  const home = path.resolve(options.home);
  const empty: LearningStatus = { state: "not-configured", plan: null, drafts: [], totalDrafts: 0, hasMore: false };
  if (!await directoryExists(home, signal)) return empty;
  const settings = await record(path.join(home, "settings.json"), 4096, signal);
  if (!settings) return empty;
  const planId = id(settings.activePlanId);
  const planFile = path.join(home, "plans", `${planId}.json`);
  const storedPlan = await record(planFile, 128 * 1024, signal);
  if (!storedPlan) throw new LearnError("NO_PLAN", "所选计划记录不存在；只读状态查询不会创建或修复计划。");
  const plan = validatePlan(storedPlan);
  if (plan.id !== planId) throw new LearnError("INVALID_STATUS_RECORD", "计划 ID 与文件名不一致。");
  const drafts: LearningStatus["drafts"] = [];
  const directory = path.join(home, "drafts");
  if (await directoryExists(directory, signal)) {
    const names: string[] = [];
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      signal?.throwIfAborted();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(entry.name)) continue;
      names.push(entry.name);
      if (names.length > options.maxScan) throw new LearnError("STATUS_SCAN_LIMIT", "草稿文件数超过 maxScan；请由用户调整配置，不返回貌似完整的部分列表。");
    }
    for (const name of names.sort()) {
      const draft = await record(path.join(directory, name), 8 * 1024 * 1024, signal);
      // A removed file is a concurrent snapshot change, not an empty or repaired draft.
      if (!draft) throw new LearnError("STATUS_CHANGED", "查询期间草稿列表变化，请重新查询。");
      if (draft.planId !== plan.id) continue;
      const draftId = id(draft.id);
      if (`${draftId}.json` !== name || !Number.isSafeInteger(draft.planRevision) || Number(draft.planRevision) < 1
        || ![undefined, "material", "course", "practice"].includes(draft.kind as string | undefined)
        || !Array.isArray(draft.publishedPaths) || !draft.publishedPaths.every(p => typeof p === "string")
        || typeof draft.createdAt !== "string" || !Number.isFinite(Date.parse(draft.createdAt))) {
        throw new LearnError("INVALID_STATUS_RECORD", "草稿元数据无效；未返回正文或底层记录。");
      }
      const course = draft.kind === "course" ? object(draft.course) : undefined;
      drafts.push({ id: draftId, title: text(draft.title, "草稿标题", 500),
        kind: draft.kind === "course" ? course?.tutorial === true ? "tutorial" : "course" : draft.kind === "practice" ? "practice" : "material",
        planRevision: Number(draft.planRevision), createdAt: draft.createdAt, published: draft.publishedPaths.length > 0 });
    }
  }
  signal?.throwIfAborted();
  const currentSettings = await record(path.join(home, "settings.json"), 4096, signal);
  const currentPlan = await record(planFile, 128 * 1024, signal);
  if (currentSettings?.activePlanId !== planId || JSON.stringify(currentPlan) !== JSON.stringify(storedPlan)) {
    throw new LearnError("STATUS_CHANGED", "查询期间学习计划变化，请重新查询。");
  }
  drafts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  return { state: "ready", plan: { id: plan.id, revision: plan.revision, title: plan.title },
    drafts: drafts.slice(0, options.maxDrafts), totalDrafts: drafts.length, hasMore: drafts.length > options.maxDrafts };
}
