import { Store } from "./store.ts";
import { BilibiliProvider } from "./bilibili.ts";
import { LearnError, ModelRunError } from "./types.ts";
import type { Draft, Material, ModelRunner, ModelUsage, Notes, Plan } from "./types.ts";
import { addUsage, emptyUsage } from "./usage.ts";
import { hash } from "./validate.ts";
import { modelPrompt, parseNotes, PROMPT_VERSION, renderMarkdown, splitSegments, SYSTEM_PROMPT } from "./notes.ts";
import { publishMarkdown } from "./files.ts";

export const MAX_MODEL_CALLS = 12;
export class LearnService {
  readonly store: Store;
  readonly provider: BilibiliProvider;
  constructor(store: Store, provider = new BilibiliProvider(store)) { this.store = store; this.provider = provider; }
  async fromVideo(input: string, run: ModelRunner, signal?: AbortSignal, progress: (message: string) => void = () => {}): Promise<{ draft: Draft; reused: boolean; usage: ModelUsage }> {
    const plan = await this.store.activePlan();
    this.checkConsent(plan);
    progress("正在获取指定分 P 的字幕（只读）…");
    const material = await this.provider.load(input, plan.language, signal);
    return this.generate(plan, material, run, signal, progress);
  }
  async fromMaterial(materialId: string, run: ModelRunner, signal?: AbortSignal, progress: (message: string) => void = () => {}) {
    const plan = await this.store.activePlan();
    this.checkConsent(plan);
    return this.generate(plan, await this.store.material(materialId), run, signal, progress);
  }
  checkConsent(plan: Plan): void {
    if (!plan.consentModelTransfer) throw new LearnError("CONSENT_REQUIRED", "请先通过 /learn setup 允许将字幕和学习目标发送到当前模型服务。");
  }
  async generate(plan: Plan, material: Material, run: ModelRunner, signal?: AbortSignal, progress: (message: string) => void = () => {}) {
    this.checkConsent(plan);
    const chunks = splitSegments(material.segments);
    if (chunks.length > MAX_MODEL_CALLS) throw new LearnError("MODEL_BUDGET", `该材料需要 ${chunks.length} 次模型请求，超过 ${MAX_MODEL_CALLS} 次上限；未截断或调用模型，请拆分课程。`);
    const draftId = hash({ plan, material: material.id, prompt: PROMPT_VERSION });
    return this.store.lock(`generate-${draftId}`, async () => {
      signal?.throwIfAborted();
      const previous = await this.store.read<Draft>("drafts", draftId);
      if (previous) return { draft: await this.store.draft(draftId), reused: true, usage: emptyUsage() };
      const prior = await this.store.read<Record<string, unknown>>("jobs", draftId);
      if (prior && ["running", "failed", "cancelled"].includes(String(prior.status))) {
        throw new LearnError("RETRY_REQUIRED", `该任务上次未完成，不会自动再次消耗模型额度。人工确认后运行 /learn retry ${draftId}`);
      }
      const usage = emptyUsage(), notes: Notes[] = [];
      const job = { id: draftId, kind: "generation", planId: plan.id, planRevision: plan.revision, materialId: material.id,
        at: new Date().toISOString(), history: Array.isArray(prior?.history) ? prior.history : [] };
      await this.store.write("jobs", draftId, { ...job, status: "running", usage });
      try {
        for (let i = 0; i < chunks.length; i++) {
          signal?.throwIfAborted();
          progress(`正在整理第 ${i + 1}/${chunks.length} 段字幕…`);
          const request = modelPrompt(plan, material, chunks[i]!, i + 1, chunks.length);
          const result = await run({ system: SYSTEM_PROMPT, prompt: request, maxTokens: 4500, signal });
          addUsage(usage, result.usage);
          await this.store.write("jobs", draftId, { ...job, status: "running", completedChunks: i + 1, usage });
          signal?.throwIfAborted();
          notes.push(parseNotes(result.text, chunks[i]!, plan));
        }
        const draft: Draft = { schemaVersion: 1, id: draftId, planId: plan.id, planRevision: plan.revision, materialId: material.id,
          title: material.title, markdown: renderMarkdown(plan, material, notes, draftId), createdAt: new Date().toISOString(), usage, publishedPaths: [] };
        await this.store.updateDraft(draft);
        await this.store.write("jobs", draftId, { ...job, status: "draft", completedChunks: chunks.length, usage });
        return { draft, reused: false, usage };
      } catch (error) {
        if (error instanceof ModelRunError) addUsage(usage, error.usage);
        await this.store.write("jobs", draftId, { ...job, status: signal?.aborted ? "cancelled" : "failed", usage,
          errorCode: error instanceof LearnError ? error.code : "MODEL_OR_NETWORK_ERROR" });
        if (error instanceof LearnError) throw new LearnError(error.code, `${error.message} 如需重试，请人工运行 /learn retry ${draftId}`);
        throw error;
      }
    });
  }
  async approveRetry(jobId: string): Promise<string> {
    return this.store.lock(`generate-${jobId}`, async () => {
      const job = await this.store.read<Record<string, unknown>>("jobs", jobId);
      const plan = await this.store.activePlan();
      if (!job || job.kind !== "generation" || !["failed", "cancelled", "running"].includes(String(job.status))) {
        throw new LearnError("INVALID_RETRY", "该任务不需要重试，或已获准重试。");
      }
      if (job.planId !== plan.id || job.planRevision !== plan.revision) throw new LearnError("PLAN_CHANGED", "任务与当前计划版本不一致，请按当前计划重新处理材料。");
      const history = Array.isArray(job.history) ? [...job.history] : [];
      if (history.length >= 20) throw new LearnError("RETRY_LIMIT", "该任务重试次数过多，请检查模型配置或调整计划。");
      const { history: _oldHistory, ...snapshot } = job;
      history.push(snapshot);
      await this.store.write("jobs", jobId, { ...job, status: "retry-approved", history });
      return String(job.materialId);
    });
  }
  async publish(draftId: string, editedMarkdown?: string): Promise<string> {
    return this.store.lock(`publish-${draftId}`, async () => {
      const draft = await this.store.draft(draftId);
      const plan = await this.store.activePlan();
      if (draft.planId !== plan.id || draft.planRevision !== plan.revision) {
        throw new LearnError("PLAN_CHANGED", "当前计划或版本与草稿不一致。请切回原计划并重新生成，不能默默改写保存位置。");
      }
      if (editedMarkdown !== undefined) {
        if (!editedMarkdown.trim() || editedMarkdown.length > 2_000_000) throw new LearnError("INVALID_DRAFT", "草稿为空或超过大小限制。");
        draft.markdown = editedMarkdown;
      }
      const destination = await publishMarkdown(plan.outputDir, plan.id, draft.title, draft.id, draft.markdown);
      draft.publishedPaths = [...new Set([...draft.publishedPaths, destination])];
      await this.store.updateDraft(draft);
      return destination;
    });
  }
}
