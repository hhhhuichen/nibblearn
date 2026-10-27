import { Store } from "./store.ts";
import { BilibiliProvider, parseCourseInputs, SubtitlesUnavailable } from "./bilibili.ts";
import { prepareVisual, visualImages } from "./media.ts";
import { courseUnitIndex, courseUnitLabel, LearnError, ModelRunError, publicError } from "./types.ts";
import type { CourseDraft, CourseJob, CourseListing, CourseOutputMode, CoursePartResult, CourseScope, ApproveTutorial, Draft, Material, MaterialDraft, ModelRunner, ModelUsage, Notes, Plan, VideoSource } from "./types.ts";
import { addUsage, emptyUsage } from "./usage.ts";
import { hash } from "./validate.ts";
import { modelPrompt, parseNotes, PROMPT_VERSION, renderMarkdown, splitSegments, SYSTEM_PROMPT, VISUAL_SYSTEM_PROMPT } from "./notes.ts";
import { publishMarkdown } from "./files.ts";
import { COURSE_DOCUMENT_VERSION, renderCourseMarkdown } from "./course.ts";
import { synthesizeCourse } from "./tutorial.ts";
import { validateReviewedMarkdown } from "./review.ts";

export const MAX_MODEL_CALLS = 12;
export class LearnService {
  readonly store: Store;
  readonly provider: BilibiliProvider;
  constructor(store: Store, provider = new BilibiliProvider(store)) { this.store = store; this.provider = provider; }
  async fromVideo(input: string, run: ModelRunner, signal?: AbortSignal, progress: (message: string) => void = () => {}, approveVisual?: (source: VideoSource, reason: string) => Promise<boolean>): Promise<{ draft: MaterialDraft; reused: boolean; usage: ModelUsage }> {
    const plan = await this.store.activePlan();
    return this.videoForPlan(plan, input, run, signal, progress, approveVisual);
  }
  private async videoForPlan(plan: Plan, input: string, run: ModelRunner, signal?: AbortSignal, progress: (message: string) => void = () => {}, approveVisual?: (source: VideoSource, reason: string) => Promise<boolean>, expectedCid?: number) {
    this.checkConsent(plan);
    progress("正在获取指定分 P 的字幕（主接口及必要时的备用接口，只读）…");
    let material: Material;
    try { material = await this.provider.load(input, plan.language, signal, expectedCid); }
    catch (error) {
      if (!(error instanceof SubtitlesUnavailable)) throw error;
      if (!approveVisual) throw error;
      const batch = this.visualBatch(run);
      if (await approveVisual(error.source, error.message) !== true) throw new LearnError("VISUAL_DECLINED", "已取消画面采样，没有下载视频或调用整理模型。");
      signal?.throwIfAborted();
      material = await prepareVisual(this.provider, error.source, batch * MAX_MODEL_CALLS, signal, progress);
    }
    return this.generate(plan, material, run, signal, progress);
  }
  /** One human-approved catalog snapshot, sequential BV/P tasks; never auto-approve generation retries. */
  async fromCourse(input: string, run: ModelRunner, approve: (course: CourseListing) => Promise<boolean | CourseOutputMode>, signal?: AbortSignal,
    progress: (message: string) => void = () => {}, approveVisual?: (source: VideoSource, reason: string) => Promise<boolean>,
    selectScope?: (scope: CourseScope) => Promise<"current" | "collection" | false>, approveTutorial?: ApproveTutorial): Promise<{ course: CourseJob; usage: ModelUsage }> {
    const plan = await this.store.activePlan();
    this.checkConsent(plan);
    const session = hash((await this.store.credentials()).sessdata);
    const inputs = parseCourseInputs(input);
    progress("正在确认课程目录，尚未获取字幕、下载媒体或调用整理模型…");
    let listing: CourseListing;
    if (inputs.length > 1) {
      if (selectScope && await selectScope({ kind: "manual", bvids: inputs }) !== "collection") throw new LearnError("COURSE_DECLINED", "已取消多链接组课，没有枚举后续视频或调用整理模型。");
      listing = await this.provider.combineCourses(inputs, "manual", `${plan.title} · 多视频课程`, signal);
    } else {
      listing = await this.provider.course(inputs[0]!, signal);
      if (listing.collection && selectScope) {
        const scope = await selectScope({ kind: "video", current: listing });
        if (!scope) throw new LearnError("COURSE_DECLINED", "已取消课程范围选择，没有获取字幕或调用整理模型。");
        if (scope === "collection") {
          if (!listing.collection.bvids || listing.collection.unavailable) throw new LearnError("COLLECTION_INCOMPLETE", "无法确认完整合集列表；没有启动不完整的合集任务，请显式提供视频链接。");
          listing = await this.provider.combineCourses(listing.collection.bvids, "season", listing.collection.title, signal, listing);
        }
      }
    }
    signal?.throwIfAborted();
    const approved = await approve(listing);
    if (approved !== true && approved !== "separate" && approved !== "merged" && approved !== "tutorial") throw new LearnError("COURSE_DECLINED", "已取消整组分 P 处理，没有下载媒体或调用整理模型。");
    const outputMode = approved === "tutorial" ? "tutorial" : approved === "merged" ? "merged" : "separate";
    signal?.throwIfAborted();
    const identity = listing.origin
      ? { plan, origin: listing.origin, videos: listing.parts.map(p => [p.bvid, p.part, p.cid]), prompt: PROMPT_VERSION, session }
      : { plan, bvid: listing.bvid, parts: listing.parts.map(p => p.cid), prompt: PROMPT_VERSION, session };
    const id = `course-${hash(identity)}`;
    return this.store.lock(id, async () => {
      const previous = await this.store.read<CourseJob>("jobs", id);
      const completed: CoursePartResult[] = [], usage = emptyUsage();
      const job: CourseJob = { id, kind: "course", planId: plan.id, planRevision: plan.revision,
        bvid: listing.bvid, title: listing.title, total: listing.parts.length,
        ...(listing.origin ? { origin: listing.origin, inputs: listing.videos!.map(video => video.bvid) } : {}),
        status: "running", completed, outputMode, at: new Date().toISOString() };
      if (previous && (previous.kind !== "course" || !Array.isArray(previous.completed))) throw new LearnError("INVALID_COURSE_CACHE", "课程进度记录无效，未自动重复调用模型。");
      // Preserve old completed entries even if cancelled before reaching them on this run.
      const persist = async () => this.store.write("jobs", id, { ...job,
        completed: [...completed, ...(previous?.completed ?? []).filter(p => !completed.some(done => done.part === p.part))], at: new Date().toISOString() });
      let currentPart = 1;
      try {
        await persist();
        for (const part of listing.parts) {
          currentPart = courseUnitIndex(part);
          signal?.throwIfAborted();
          const active = await this.store.activePlan();
          if (active.id !== plan.id || active.revision !== plan.revision) throw new LearnError("PLAN_CHANGED", "学习计划已改变，已停止后续分 P；请确认计划后重新开始。");
          if (hash((await this.store.credentials()).sessdata) !== session) throw new LearnError("ACCOUNT_CHANGED", "登录凭据已改变，已停止后续分 P；请重新确认课程范围。");
          const prior = previous?.completed.find(p => p.part === currentPart && p.cid === part.cid
            && (!listing.origin || (p.bvid === part.bvid && p.sourcePart === part.part)));
          const sourceFields = listing.origin ? { bvid: part.bvid, sourcePart: part.part, videoIndex: part.videoIndex } : {};
          let result: CoursePartResult;
          if (prior) {
            const draft = await this.store.draft(prior.draftId);
            if (draft.kind === "course" || draft.kind === "practice") throw new LearnError("INVALID_COURSE_CACHE", "分 P 缓存误指向非材料草稿，已停止处理。");
            const material = await this.store.material(draft.materialId);
            const visual = material.kind === "bilibili-visual";
            const expectedId = hash({ plan, material: material.id, prompt: visual ? `${PROMPT_VERSION}-visual-v1` : PROMPT_VERSION });
            if (draft.id !== expectedId || draft.planId !== plan.id || draft.planRevision !== plan.revision
              || material.bvid !== part.bvid || material.cid !== part.cid || material.part !== part.part) {
              throw new LearnError("INVALID_COURSE_CACHE", "课程缓存与当前计划或分 P 不一致，未自动重新生成。");
            }
            result = { part: currentPart, ...sourceFields, cid: part.cid, title: draft.title, draftId: draft.id, visual, reused: true };
          } else {
            const generated = await this.videoForPlan(plan, part.sourceUrl, run, signal,
              message => progress(`${courseUnitLabel(part)}（${currentPart}/${listing.parts.length}）：${message}`), approveVisual, part.cid);
            addUsage(usage, generated.usage);
            const material = await this.store.material(generated.draft.materialId);
            result = { part: currentPart, ...sourceFields, cid: part.cid, title: generated.draft.title, draftId: generated.draft.id,
              visual: material.kind === "bilibili-visual", reused: generated.reused };
          }
          completed.push(result);
          await persist();
          progress(`${listing.origin ? `${courseUnitLabel(part)}（${currentPart}/${listing.parts.length}）` : `P${part.part}/${listing.parts.length}`} ${result.reused ? "复用" : "完成"}：${result.title}；${result.visual ? "仅采样画面" : "字幕讲义"}；草稿 ${result.draftId}`);
        }
        job.status = "completed";
      } catch (error) {
        job.status = signal?.aborted ? "cancelled" : "stopped";
        job.stoppedPart = currentPart;
        const stopped = listing.parts.find(part => courseUnitIndex(part) === currentPart);
        if (stopped && listing.origin) job.stoppedLabel = courseUnitLabel(stopped);
        job.error = publicError(error);
        // Finished drafts remain available; failed P usage stays in its generation job.
      }
      if (outputMode === "merged" && completed.length) {
        try {
          progress("正在本机编排合并讲义，不增加模型请求…");
          job.mergedDraftId = (await this.mergeCourse(plan, listing, job)).id;
        } catch (error) {
          job.mergeError = publicError(error);
          // Assembly failure must not discard paid P drafts or pretend a merged document exists.
        }
      }
      await persist();
      if (outputMode === "tutorial") {
        if (job.status !== "completed") job.tutorialError = "课程素材尚未全部完成，未自动开始综合。可修复后继续课程，或用 /learn tutorial <课程ID> 明确确认部分素材综合。";
        else if (!approveTutorial) job.tutorialError = "综合阶段需要额外的人工预算确认，没有调用综合模型。";
        else {
          try {
            const result = await synthesizeCourse(this.store, job.id, run, approveTutorial, signal, progress);
            addUsage(usage, result.usage);
            job.tutorialJobId = result.jobId; job.tutorialDraftId = result.draftId; job.tutorialError = result.error;
          } catch (error) { job.tutorialError = publicError(error); }
        }
        await persist();
      }
      return { course: job, usage };
    });
  }
  async tutorial(input: string, run: ModelRunner, approve: ApproveTutorial, signal?: AbortSignal, progress?: (message: string) => void) {
    return synthesizeCourse(this.store, input, run, approve, signal, progress);
  }
  private async mergeCourse(plan: Plan, listing: CourseListing, job: CourseJob): Promise<CourseDraft> {
    const chapters: MaterialDraft[] = [];
    const usage = emptyUsage();
    let inputCharacters = 0;
    for (const part of job.completed) {
      const draft = await this.store.draft(part.draftId);
      if (draft.kind === "course" || draft.kind === "practice" || draft.planId !== plan.id || draft.planRevision !== plan.revision) {
        throw new LearnError("INVALID_COURSE_CACHE", "合并来源不是当前计划版本的分 P 草稿。");
      }
      inputCharacters += draft.markdown.length;
      if (inputCharacters > 2_000_000) throw new LearnError("COURSE_DOCUMENT_TOO_LARGE", "待合并的分 P 草稿合计超过 2,000,000 字符，已停止读取更多章节；各 P 草稿保留，没有截断或自动发布，可重新选择分别成文。");
      chapters.push(draft);
      addUsage(usage, draft.usage);
    }
    // Content hash preserves old partial/edited editions and supports layout changes without regenerating P content.
    const id = hash({ course: job.id, document: COURSE_DOCUMENT_VERSION, title: listing.title,
      chapters: chapters.map((draft, index) => [job.completed[index]!.part, draft.id, hash(draft.markdown)]),
      listing: listing.parts.map(p => listing.origin ? [p.bvid, p.part, p.index, p.cid, p.title] : [p.part, p.cid, p.title]) });
    if (await this.store.read<Draft>("drafts", id)) {
      const previous = await this.store.draft(id);
      if (previous.kind !== "course") throw new LearnError("INVALID_COURSE_CACHE", "合并草稿缓存类型不符。");
      return previous;
    }
    const markdown = renderCourseMarkdown(plan, listing, job, chapters, id);
    if (markdown.length > 2_000_000) throw new LearnError("COURSE_DOCUMENT_TOO_LARGE", "合并讲义超过现有 2,000,000 字符草稿上限；各 P 草稿已保留，没有截断或自动发布。可重新选择分别成文。");
    const draft: CourseDraft = { schemaVersion: 1, kind: "course", id, planId: plan.id, planRevision: plan.revision,
      title: `${listing.title} · 合并讲义${job.completed.length < listing.parts.length ? "（部分）" : ""}`, markdown,
      course: { jobId: job.id, bvid: listing.bvid, total: listing.parts.length, parts: job.completed },
      createdAt: new Date().toISOString(), usage, publishedPaths: [] };
    await this.store.updateDraft(draft);
    return draft;
  }
  private visualBatch(run: ModelRunner): number {
    if (run.supportsImages !== true) throw new LearnError("VISION_MODEL_REQUIRED", "没有可用字幕，画面兜底需要支持图片输入的模型。请通过 /model 切换看图模型，或用 /learn import 导入字幕。");
    const limit = run.maxImagesPerRequest ?? 2;
    if (!Number.isFinite(limit) || limit < 1) throw new LearnError("VISION_MODEL_LIMIT", "当前模型不允许图片输入，不能把画面标签当作字幕生成内容。");
    return Math.min(2, Math.floor(limit));
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
    const visual = material.kind === "bilibili-visual";
    const batch = visual ? this.visualBatch(run) : 0;
    const indexed = material.segments.map((segment, index) => ({ ...segment, index }));
    const chunks = visual ? Array.from({ length: Math.ceil(indexed.length / batch) }, (_, index) => indexed.slice(index * batch, (index + 1) * batch)) : splitSegments(material.segments);
    if (chunks.length > MAX_MODEL_CALLS) throw new LearnError("MODEL_BUDGET", `该材料需要 ${chunks.length} 次模型请求，超过 ${MAX_MODEL_CALLS} 次上限；未截断或调用模型，请拆分课程。`);
    const draftId = hash({ plan, material: material.id, prompt: visual ? `${PROMPT_VERSION}-visual-v1` : PROMPT_VERSION });
    return this.store.lock(`generate-${draftId}`, async () => {
      signal?.throwIfAborted();
      const previous = await this.store.read<Draft>("drafts", draftId);
      if (previous) {
        const draft = await this.store.draft(draftId);
        if (draft.kind === "course" || draft.kind === "practice") throw new LearnError("INVALID_DRAFT", "单份材料缓存误指向非材料草稿。");
        return { draft, reused: true, usage: emptyUsage() };
      }
      const prior = await this.store.read<Record<string, unknown>>("jobs", draftId);
      if (prior && ["running", "failed", "cancelled"].includes(String(prior.status))) {
        throw new LearnError("RETRY_REQUIRED", `该任务上次未完成，不会自动再次消耗模型额度。人工确认后运行 /learn retry ${draftId}`);
      }
      const usage = emptyUsage(), notes: Notes[] = [];
      const job = { id: draftId, kind: "generation", planId: plan.id, planRevision: plan.revision, materialId: material.id,
        at: new Date().toISOString(), history: Array.isArray(prior?.history) ? prior.history : [] };
      await this.store.write("jobs", draftId, { ...job, status: "running", usage });
      try {
        // Verify every cached image before the first paid call, not halfway through a course.
        if (visual) for (const segment of indexed) { signal?.throwIfAborted(); await visualImages(this.store, material, [segment.index]); }
        for (let i = 0; i < chunks.length; i++) {
          signal?.throwIfAborted();
          progress(visual ? `正在整理第 ${i + 1}/${chunks.length} 批采样画面（不是视频全文）…` : `正在整理第 ${i + 1}/${chunks.length} 段字幕…`);
          const request = modelPrompt(plan, material, chunks[i]!, i + 1, chunks.length, notes);
          const images = visual ? await visualImages(this.store, material, chunks[i]!.map(segment => segment.index)) : undefined;
          const result = await run({ system: visual ? VISUAL_SYSTEM_PROMPT : SYSTEM_PROMPT, prompt: request, ...(images ? { images } : {}), signal });
          addUsage(usage, result.usage);
          await this.store.write("jobs", draftId, { ...job, status: "running", completedChunks: i + 1, usage });
          signal?.throwIfAborted();
          notes.push(parseNotes(result.text, chunks[i]!, plan));
        }
        const draft: MaterialDraft = { schemaVersion: 1, id: draftId, planId: plan.id, planRevision: plan.revision, materialId: material.id,
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
  async saveReviewedDraft(draftId: string, markdown: string, expectedHash: string): Promise<void> {
    validateReviewedMarkdown(markdown);
    await this.store.lock(`publish-${draftId}`, async () => {
      const draft = await this.store.draft(draftId), plan = await this.store.activePlan();
      if (draft.planId !== plan.id || draft.planRevision !== plan.revision) throw new LearnError("PLAN_CHANGED", "审核期间学习计划已改变，请重新选择草稿。");
      if (hash(draft.markdown) !== expectedHash) throw new LearnError("REVIEW_CONFLICT", "审核期间草稿已被其他操作修改，未覆盖；请重新审核。");
      await this.store.updateDraft({ ...draft, markdown });
    });
  }
  async publish(draftId: string, editedMarkdown?: string, expectedHash?: string): Promise<string> {
    return this.store.lock(`publish-${draftId}`, async () => {
      const draft = await this.store.draft(draftId);
      const plan = await this.store.activePlan();
      if (draft.planId !== plan.id || draft.planRevision !== plan.revision) {
        throw new LearnError("PLAN_CHANGED", "当前计划或版本与草稿不一致。请切回原计划并重新生成，不能默默改写保存位置。");
      }
      if (expectedHash !== undefined && hash(draft.markdown) !== expectedHash) {
        throw new LearnError("REVIEW_CONFLICT", "最终确认期间草稿发生变化，未发布；请重新审核。");
      }
      if (editedMarkdown !== undefined) draft.markdown = validateReviewedMarkdown(editedMarkdown);
      const destination = await publishMarkdown(plan.outputDir, plan.id, draft.title, draft.id, draft.markdown);
      draft.publishedPaths = [...new Set([...draft.publishedPaths, destination])];
      await this.store.updateDraft(draft);
      return destination;
    });
  }
}
