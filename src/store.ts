import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertDirectory, atomicText, defaultHome, ensureDirectory, readText, safeChildDirectory, withFileLock } from "./files.ts";
import { hash, id, object, parseJson, validateCredentials, validatePlan, validateSegments, validateVisualAssets } from "./validate.ts";
import { LearnError } from "./types.ts";
import type { Credentials, Draft, Material, Plan } from "./types.ts";

type Bucket = "plans" | "drafts" | "materials" | "jobs" | "secrets" | "locks" | "traffic";
export class Store {
  readonly home: string;
  constructor(home = defaultHome()) { this.home = path.resolve(home); }
  async init(): Promise<void> { await ensureDirectory(this.home); }
  async directory(bucket: Bucket): Promise<string> {
    await this.init();
    return safeChildDirectory(this.home, bucket);
  }
  async read<T>(bucket: Bucket, key: string): Promise<T | undefined> {
    const file = path.join(await this.directory(bucket), `${id(key)}.json`);
    try { return parseJson(await readText(file)) as T; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  }
  async write(bucket: Bucket, key: string, value: unknown): Promise<void> {
    const directory = await this.directory(bucket);
    await atomicText(path.join(directory, `${id(key)}.json`), JSON.stringify(value, null, 2) + "\n");
  }
  async list<T>(bucket: Bucket): Promise<T[]> {
    const directory = await this.directory(bucket);
    const names = (await fs.readdir(directory)).filter(n => /^[a-zA-Z0-9_-]+\.json$/.test(n));
    const records: T[] = [];
    for (const name of names) {
      const value = await this.read<T>(bucket, name.slice(0, -5));
      if (value !== undefined) records.push(value);
    }
    return records;
  }
  async activePlan(): Promise<Plan> {
    await this.init();
    let settings: Record<string, unknown>;
    try { settings = object(parseJson(await readText(path.join(this.home, "settings.json")))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new LearnError("NO_PLAN", "请先运行 /learn setup 创建学习计划。"); throw e; }
    const plan = await this.read("plans", id(settings.activePlanId));
    if (!plan) throw new LearnError("NO_PLAN", "所选学习计划不存在，请运行 /learn plans。");
    return validatePlan(plan);
  }
  async selectPlan(planId: string): Promise<Plan> {
    const plan = await this.read("plans", id(planId));
    if (!plan) throw new LearnError("NO_PLAN", "找不到该学习计划。");
    const validated = validatePlan(plan);
    await atomicText(path.join(this.home, "settings.json"), JSON.stringify({ activePlanId: validated.id }) + "\n");
    return validated;
  }
  async savePlan(value: Plan): Promise<Plan> {
    const plan = validatePlan(value);
    return this.lock(`plan-${plan.id}`, async () => {
      const existing = await this.read<Plan>("plans", plan.id);
      if (existing && existing.revision !== plan.revision) throw new LearnError("PLAN_CHANGED", "计划已被其他会话修改，请重新打开设置。");
      const next = { ...plan, revision: existing ? existing.revision + 1 : 1 };
      await this.write("plans", plan.id, next);
      return next;
    });
  }
  async credentials(): Promise<Credentials> {
    const value = await this.read("secrets", "credentials");
    if (!value) throw new LearnError("NEED_LOGIN", "尚未配置 Bilibili 登录态。请运行 /learn auth；不要把 Cookie 发到聊天里。");
    return validateCredentials(value);
  }
  async saveCredentials(value: unknown): Promise<void> {
    await this.write("secrets", "credentials", validateCredentials(value));
  }
  async hasCredentials(): Promise<boolean> { try { await this.credentials(); return true; } catch { return false; } }
  async saveMaterial(material: Omit<Material, "id">): Promise<Material> {
    const segments = validateSegments(material.segments);
    const visual = material.kind === "bilibili-visual" ? validateVisualAssets(material.visual, segments) : undefined;
    const normalized = { ...material, segments, ...(visual ? { visual } : {}) };
    const value: Material = { ...normalized, id: hash({ ...normalized, fetchedAt: undefined }) };
    await this.write("materials", value.id, value);
    return value;
  }
  async material(key: string): Promise<Material> {
    const value = await this.read<Material>("materials", id(key));
    if (!value) throw new LearnError("NO_MATERIAL", "找不到字幕材料。");
    const segments = validateSegments(value.segments);
    return { ...value, segments, ...(value.kind === "bilibili-visual" ? { visual: validateVisualAssets(value.visual, segments) } : {}) };
  }
  async draft(key: string): Promise<Draft> {
    const value = await this.read<Draft>("drafts", id(key));
    if (!value || typeof value.markdown !== "string" || value.markdown.length > 2_000_000) throw new LearnError("NO_DRAFT", "找不到有效草稿。");
    return value;
  }
  async lock<T>(key: string, action: () => Promise<T>): Promise<T> {
    return withFileLock(await this.directory("locks"), id(key), action);
  }
  async updateDraft(draft: Draft): Promise<void> {
    await assertDirectory(await this.directory("drafts"));
    await this.write("drafts", id(draft.id), draft);
  }
  newPlanId(): string { return `plan-${randomUUID().slice(0, 8)}`; }
}
