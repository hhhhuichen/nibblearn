import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BilibiliProvider, parseCourseInputs, parseVideo } from "../src/bilibili.ts";
import { availableBrowsers, BilibiliAccount } from "../src/account/index.ts";
import type { BrowserKind } from "../src/account/index.ts";
import { ensureDirectory, expandPath, readText } from "../src/files.ts";
import { Store } from "../src/store.ts";
import { LearnService, MAX_MODEL_CALLS } from "../src/service.ts";
import { importSubtitle } from "../src/subtitles.ts";
import { findFfmpeg } from "../src/media.ts";
import { MAX_TUTORIAL_CALLS, MAX_TUTORIAL_CHAPTERS } from "../src/tutorial.ts";
import { courseUnitLabel, LearnError, ModelRunError, publicError } from "../src/types.ts";
import type { CourseJob, CourseOutputMode, CourseScope, ApproveTutorial, Draft, ModelRunner, Plan, VideoSource } from "../src/types.ts";
import { hash, parseJson, validatePlan } from "../src/validate.ts";

const HELP = `# Nibblearn

- setup：创建任意主题的学习计划，选择保存目录
- plans / use <ID>：选择学习计划
- config：编辑当前计划（修改会产生新版本）
- auth：选择 Edge/Chrome，在专用窗口登录 Bilibili，回到 pi 检查并确认账号；无需复制 Cookie
- video <BV号或完整链接>：只处理指定分 P（默认 P1），优先字幕；无字幕时可确认采样画面
- course <一个或多个BV号/链接>：选定范围后处理所有 P；可分别成文、资料合并或额外确认后重编综合教程
- tutorial <课程ID或合并稿ID>：仅用已有草稿进行跨视频选材、去重和重编；不下载视频，额外用量需确认
- import <字幕文件路径>：导入 SRT/VTT/JSON 后生成草稿，不必登录 Bilibili
- reference <文本文件路径>：添加用户提供的参考材料（.md/.txt，最多8000字符）
- review [草稿ID] / save [草稿ID]：预览、编辑，确认后保存；绝不覆盖已有文件
- status：查看计划、最近草稿与失败任务
- retry <任务ID>：人工确认后重试失败或中断任务
- resume：人工处理登录/验证码后解除本地账号暂停，不绕过平台退避
- cancel：取消本插件正在执行的任务

使用 pi 当前模型和认证。字幕、学习目标、参考材料会发送给该模型服务；画面兜底另需确认上传图片。
画面兜底需要已安装的 FFmpeg 和看图模型，只整理离散采样，不代表完整观看或听过视频，无内置语音转写。
不自动评论、私信、点赞或在浏览器播放视频。`;

function requireUI(ctx: ExtensionContext): void {
  if (!ctx.hasUI) throw new LearnError("UI_REQUIRED", "此操作需要交互确认，请在 pi 终端或支持对话框的 RPC 客户端运行。");
}
function modelRunner(ctx: ExtensionContext): ModelRunner {
  const model = ctx.model;
  if (!model) throw new LearnError("NO_MODEL", "请先在 pi 中选择并登录一个模型。");
  const imageLimits = model.inputLimits?.images;
  const imageLimit = Math.min(2, imageLimits?.maxPerMessage ?? 2, imageLimits?.maxPerRequest ?? 2);
  const run: ModelRunner = async request => {
    const images = request.images ?? [];
    if (images.length && !model.input.includes("image")) throw new LearnError("VISION_MODEL_REQUIRED", "当前模型不支持图片输入，请通过 /model 切换看图模型。");
    if (images.length > imageLimit) throw new LearnError("VISION_MODEL_LIMIT", "图片数量超过当前模型的单次上限，没有静默丢弃画面。");
    if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0
      || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
      throw new LearnError("MODEL_LIMITS", "当前模型未声明有效的最大输出量或上下文窗口，请检查 pi 模型配置；没有猜测额度或发起请求。");
    }
    if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)) {
      throw new LearnError("MODEL_LIMITS", "请求的输出上限必须是正整数。");
    }
    // Conservative estimate, not exact tokenization or billing; images vary by provider.
    const inputBudget = Buffer.byteLength(request.system + request.prompt, "utf8") + images.length * 8192 + 1024;
    const availableOutput = model.contextWindow - inputBudget;
    if (availableOutput < 1) {
      throw new LearnError("MODEL_CONTEXT", "当前模型上下文不足，请选择更大上下文模型、减少参考资料或拆分字幕；未截断材料。");
    }
    const maxTokens = Math.min(request.maxTokens ?? model.maxTokens, model.maxTokens, availableOutput);
    const content = [{ type: "text" as const, text: request.prompt }, ...images.map(image => ({ type: "image" as const, ...image }))];
    const context = { systemPrompt: request.system, messages: [{ role: "user" as const, content, timestamp: Date.now() }] };
    if (model.inputLimits?.maxRequestBytes && Buffer.byteLength(JSON.stringify(context), "utf8") + 4096 > model.inputLimits.maxRequestBytes) {
      throw new LearnError("MODEL_REQUEST_SIZE", "图文请求超过当前模型的请求大小上限，没有截断图片。");
    }
    let response;
    try {
      response = await ctx.modelRegistry.streamSimple(model, {
        ...context,
        // No tools and no conversation history are provided to the nested model.
      }, { signal: request.signal, maxTokens, cacheRetention: "none" }).result();
    } catch {
      if (request.signal?.aborted) throw request.signal.reason;
      throw new LearnError("MODEL_REQUEST_FAILED", "当前模型调用失败，请检查 pi 的模型连接；未回显服务端请求详情。");
    }
    if (response.stopReason === "aborted") throw new DOMException("Cancelled", "AbortError");
    if (response.stopReason !== "stop") throw new ModelRunError("MODEL_INCOMPLETE", "模型输出未正常完成，可能达到输出限制；没有发布不完整笔记。", response.usage);
    const output = response.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    return { text: output, usage: response.usage };
  };
  run.supportsImages = model.input.includes("image");
  run.maxImagesPerRequest = imageLimit;
  return run;
}

export function createLearnExtension(options: { home?: string; transport?: typeof fetch } = {}) {
  return function nibblearnPi(pi: ExtensionAPI): void {
    // Registration only. Do not read credentials, create directories or start timers on load.
    const controllers = new Set<AbortController>();
    const workTasks = new Set<Promise<unknown>>();
    const accounts = new Set<BilibiliAccount>();
    let authentication: Promise<void> | undefined;
    const service = () => {
      const store = new Store(options.home);
      return new LearnService(store, new BilibiliProvider(store, options.transport));
    };
    const report = (content: string) => pi.sendMessage({ customType: "nibblearn", content, display: true });
    const work = <T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      controllers.add(controller);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const task = (async () => { try { return await action(combined); } finally { controllers.delete(controller); } })();
      workTasks.add(task);
      void task.then(() => workTasks.delete(task), () => workTasks.delete(task));
      return task;
    };
    pi.on("session_shutdown", async () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
      // Wait for owned FFmpeg processes, temporary downloads and login windows to close.
      await Promise.allSettled([...workTasks, ...[...accounts].map(account => account.close())]);
    });

    const visualApproval = (ctx: ExtensionContext, run: ModelRunner, signal: AbortSignal) => async (source: VideoSource, reason: string) => {
      requireUI(ctx);
      await findFfmpeg();
      return ctx.ui.confirm("没有可用字幕，改用采样画面？", `${reason}\n\n视频：${source.title}\n分 P：${source.part}；时长：${source.duration ?? "未知"} 秒\n\n将下载当前可访问的视频流（最多 256 MiB），在全程最多采样 ${MAX_MODEL_CALLS * Math.min(2, run.maxImagesPerRequest ?? 2)} 个时间点，读取画面及底部硬字幕。图片会发送给当前模型，最多 ${MAX_MODEL_CALLS} 次整理请求并消耗额度。\n\n不会处理音频、读取评论或绕过访问限制。这只能生成采样画面概要，可能漏掉重要讲解，不是视频全文。只处理你有权访问的内容；图片可能包含视频中可见的个人信息，请确认允许发送。临时视频会删除，画面保存在本机缓存供复用。是否同意？`, { signal });
    };
    const chooseCourseScope = (ctx: ExtensionContext, signal: AbortSignal) => async (scope: CourseScope): Promise<"current" | "collection" | false> => {
      if (scope.kind === "manual") {
        return await ctx.ui.confirm("按这些链接组课？", `共 ${scope.bvids.length} 个不同 BV，按提供顺序处理，每个 BV 将包含全部分 P；重复 BV 已去重，链接中的 p 不限定课程范围。\n${scope.bvids.join("\n")}\n\n下一步只读取这些视频的目录信息，不递归扩展各自所属合集；获取完整数量后还会确认输出方式和累计模型用量。是否读取目录？`, { signal }) === true ? "collection" : false;
      }
      const collection = scope.current.collection!;
      const currentLabel = `仅当前视频：${scope.current.parts.length} 个分 P`;
      const collectionLabel = `整个投稿合集：${collection.title}（${collection.bvids?.length ?? 0} 个独立视频，每个视频包含全部分 P）`;
      if (collection.unavailable) ctx.ui.notify(collection.unavailable, "warning");
      const options = collection.bvids && !collection.unavailable ? [collectionLabel, currentLabel] : [currentLabel];
      const selected = await ctx.ui.select("选择课程范围；取消则停止", options, { signal });
      return selected === currentLabel ? "current" : options.includes(collectionLabel) && selected === collectionLabel ? "collection" : false;
    };
    const tutorialApproval = (ctx: ExtensionContext): ApproveTutorial => async (summary, signal) => {
      requireUI(ctx);
      if (summary.stage === "outline") return ctx.ui.confirm("确认教程学习路线后继续？", `${summary.chapters!.map((title, i) => `${i + 1}. ${title}`).join("\n")}\n\n取舍说明：\n${summary.omitted?.map(item => `- ${item.count} 个素材块：${item.reason}`).join("\n") || "没有声明省略项"}\n\n还需最多 ${summary.maxNewCalls} 次章节编写请求。已有 ${summary.completedChapters} 章会复用；不是逐视频拼接，也不是事实核验。取消会保留已付费用量和规划，稍后可人工确认继续。`, { signal });
      return ctx.ui.confirm(summary.resuming ? "确认继续未完成的教程综合？" : "确认额外模型用量，重编综合教程？", `${summary.title}\n已有 ${summary.sourceParts}/${summary.totalParts} 个 P，提取 ${summary.units} 个知识/补充/限制素材块。\n其中 ${summary.visualSourceParts} 个 P 仅有旧稿画面描述；${summary.excludedSupplementBlocks} 个旧稿补充块因当前计划未允许模型补充而未采用。${summary.sourceParts < summary.totalParts ? "\n注意：素材未齐，只能生成部分素材教程。" : ""}\n\n新增请求最多 ${summary.maxNewCalls} 次（首次最多1次规划及${MAX_TUTORIAL_CHAPTERS}次章节编写），单次输出采用当前模型上限，可能增加费用与等待。\n\n仅发送既有草稿的正文、限制说明及当前计划允许的参考材料；不发送整份长引文索引、账号凭据、保存目录或会话历史，不重传图片/音频、不重新下载视频。旧模型笔记不是已核验事实，画面材料的缺口仍会保留。\n\n${summary.resuming ? `此前已完成 ${summary.completedChapters} 章，只继续未完成章节；失败请求可能已收费，累计用量保留。本次确认也代表同意重新尝试失败步骤。` : "规划完成后还会让你确认章节与取舍，再开始写正文。"}\n\n任务ID：${summary.jobId}\n原稿不会覆盖，成品仍须 /learn review 审核保存。是否继续？`, { signal });
    };
    const courseStatuses = async (store: Store, plan: Plan) => (await store.list<CourseJob>("jobs"))
      .filter(job => job.kind === "course" && job.planId === plan.id)
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10)
      .map(job => ({ id: job.id, bvid: job.bvid, title: job.title, revision: job.planRevision, status: job.status,
        completed: job.completed.length, total: job.total, stoppedPart: job.stoppedPart, error: job.error,
        outputMode: job.outputMode ?? "separate", mergedDraftId: job.mergedDraftId, mergeError: job.mergeError,
        inputs: job.inputs, origin: job.origin, stoppedLabel: job.stoppedLabel,
        tutorialDraftId: job.tutorialDraftId, tutorialJobId: job.tutorialJobId, tutorialError: job.tutorialError }));
    const toolOutput = Type.Object({ draftId: Type.String(), title: Type.String(), reused: Type.Boolean() });
    const generateTool = (kind: "video" | "material") => {
      pi.registerTool({
        name: kind === "video" ? "learn_video" : "learn_generate",
        label: kind === "video" ? "学习视频材料" : "整理已导入材料",
        description: kind === "video"
          ? "按当前学习计划读取一个 Bilibili 视频（支持 ?p= 指定分 P），优先主/备用字幕；缺字幕时必须由用户通过对话框同意下载和图片传输，才进行视觉采样。只生成有来源的草稿，无平台写操作。"
          : "按当前学习计划整理已导入或已缓存的材料 ID。画面材料须另经用户确认图片传输；不会读取任意文件，不发布成品。",
        promptSnippet: "按用户学习计划生成有来源的字幕笔记草稿；成品保存须由用户运行 /learn review 确认。",
        promptGuidelines: ["不得索要或通过 read/bash 获取 Cookie；用户通过 /learn auth 在专用浏览器登录并确认账号。", "草稿不是已核验事实，不使用普通 write 工具绕过 /learn review 发布。"],
        parameters: Type.Object({ input: Type.String({ description: kind === "video" ? "BV号或完整HTTPS视频链接，分P用?p=2" : "已导入的材料ID" }) }),
        outputSchema: toolOutput,
        executionMode: "sequential",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const svc = service();
          const run = modelRunner(ctx);
          const result = await work(signal, async signal => {
            const progress = (message: string) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
            if (kind === "video") return svc.fromVideo(params.input, run, signal, progress, visualApproval(ctx, run, signal));
            const material = await svc.store.material(params.input);
            if (material.kind === "bilibili-visual") {
              requireUI(ctx);
              if (await ctx.ui.confirm("整理缓存的采样画面？", `${material.title}\n共 ${material.segments.length} 个采样时间点。图片、学习目标和参考材料将发送给当前模型并消耗额度。这不是视频全文，也没有音频。是否同意？`, { signal }) !== true) throw new LearnError("VISUAL_DECLINED", "已取消图片传输，没有调用整理模型。");
            }
            return svc.fromMaterial(params.input, run, signal, progress);
          });
          const details = { draftId: result.draft.id, title: result.draft.title, reused: result.reused };
          const visual = (await svc.store.material(result.draft.materialId)).kind === "bilibili-visual";
          return {
            content: [{ type: "text", text: `${result.reused ? "复用已有草稿（未再次调用整理模型）" : "草稿已生成"}：${result.draft.title}\n${visual ? "材料仅为采样画面，不含声音，不是视频全文或完整课程总结。\n" : ""}草稿ID：${result.draft.id}\n尚未写入成品目录。用户运行 /learn review ${result.draft.id} 预览并确认保存。` }],
            structuredContent: details, details, usage: result.usage,
          };
        },
      });
    };
    generateTool("video");
    generateTool("material");
    pi.registerTool({
      name: "learn_course", label: "学习课程与合集",
      description: "支持单 BV 全部分 P、明确选择的投稿合集，或空格/换行分隔的多个视频链接组课。由用户选择范围与分别成文/资料合并/综合教程，确认累计用量后顺序生成讲义；不递归扩展推荐、作者投稿、收藏夹，不处理不完整合集列表。中断保留进度，不自动重试或发布。",
      promptSnippet: "用户要处理全部分 P、投稿合集或多个视频时使用 learn_course，不要自行循环调用 learn_video。",
      promptGuidelines: ["整组处理必须经工具内用户对话框批准；停止后不得自动再次调用或用单 P 工具绕过。", "分别报告字幕讲义与采样画面，不能声称完整观看；保存须由用户运行 /learn review 确认。"],
      parameters: Type.Object({ input: Type.String({ description: "一个或多个BV号/完整HTTPS视频链接，空格或换行分隔；通过用户对话框选择合集范围，每个选中BV处理全部P" }) }),
      executionMode: "sequential",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async execute(_id, params, signal, onUpdate, ctx) {
        requireUI(ctx);
        const svc = service(), run = modelRunner(ctx);
        const result = await work(signal, signal => svc.fromCourse(params.input, run, async listing => {
          const mergedLabel = "资料合并：按视频与 P 顺序拼接（不做语义综合，无额外请求）";
          const separateLabel = "分别成文：每个视频分 P 一份讲义";
          const tutorialLabel = `综合教程：跨视频去重与重编（另需最多${MAX_TUTORIAL_CALLS}次请求及预算确认）`;
          const videoCount = listing.videos?.length ?? 1;
          const selected = await ctx.ui.select(`${listing.title}（${videoCount} 个视频，${listing.parts.length} 个分 P）：选择输出方式`, [mergedLabel, separateLabel, tutorialLabel], { signal });
          if (selected !== mergedLabel && selected !== separateLabel && selected !== tutorialLabel) return false;
          const mode: CourseOutputMode = selected === tutorialLabel ? "tutorial" : selected === mergedLabel ? "merged" : "separate";
          const duration = listing.parts.every(p => p.duration !== undefined)
            ? `总时长约 ${Math.ceil(listing.parts.reduce((sum, p) => sum + p.duration!, 0) / 60)} 分钟` : "部分分 P 时长未知";
          const preview = listing.parts.slice(0, 20).map(p => `${courseUnitLabel(p)}：${p.title}`).join("\n");
          const confirmed = await ctx.ui.confirm("处理已选课程的全部内容？", `${listing.title}\n共 ${videoCount} 个视频、${listing.parts.length} 个分 P；${duration}。${listing.catalogCachedAt ? `\n部分视频目录复用 24 小时内缓存（最早 ${listing.catalogCachedAt}），近期新增 P 可能尚未体现，处理范围以本次确认列表为准。` : ""}\n${preview}${listing.parts.length > 20 ? "\n…其余分 P 也在处理范围内。" : ""}\n\n忽略链接中的 p 选择，按所确认的视频顺序，从各自 P1 处理全部 ${listing.parts.length} 个分 P。合集按平台分区与条目顺序排列；手动组课按输入顺序排列。每 P 最多 ${MAX_MODEL_CALLS} 次整理请求，整组理论最多 ${listing.parts.length * MAX_MODEL_CALLS} 次，不是整组只调用 12 次；单次输出采用当前模型上限，可能产生较多费用和等待。\n\n已完成且匹配当前计划、材料和生成规则的课程进度会复用；未完成的 P 才继续处理。无字幕时另行确认画面上传；拒绝或任何错误都会停止，不自动跳过、重试或绕过平台限流。\n\n输出方式：${mode === "tutorial" ? "先取得各 P 草稿，再单独确认额外预算，按主题进行课程级去重、选材与教程重编；不是零费用合并。" : mode === "merged" ? "按视频与 P 顺序合并为一份讲义，统一审核保存；各 P 中间草稿保留供复用。中途停止时仅收录已完成章节，并明确列出缺少的 P。" : "每 P 一份讲义，分别审核保存。"}分别成文与资料合并不增加综合调用；综合教程须另外确认用量和学习路线。不声称完整观看视频。可用 /learn cancel 停止，已完成草稿保留，需 /learn review 审核保存。是否开始？`, { signal });
          return confirmed === true ? mode : false;
        }, signal, message => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined }), visualApproval(ctx, run, signal), chooseCourseScope(ctx, signal), tutorialApproval(ctx)));
        const job = result.course;
        const details = { courseId: job.id, bvid: job.bvid, status: job.status, total: job.total,
          completed: job.completed, stoppedPart: job.stoppedPart, error: job.error,
          outputMode: job.outputMode, mergedDraftId: job.mergedDraftId, mergeError: job.mergeError,
          inputs: job.inputs, origin: job.origin, stoppedLabel: job.stoppedLabel,
          tutorialDraftId: job.tutorialDraftId, tutorialJobId: job.tutorialJobId, tutorialError: job.tutorialError };
        const output = job.outputMode === "tutorial"
          ? (job.tutorialDraftId ? `综合教程草稿：${job.tutorialDraftId}；运行 /learn review ${job.tutorialDraftId} 审核保存。` : `尚未完成教程综合：${job.tutorialError ?? "未开始"}；可运行 /learn tutorial ${job.tutorialJobId ?? job.id} 人工确认后继续。`)
          : job.outputMode === "merged"
          ? (job.mergedDraftId ? `已编排${job.completed.length < job.total ? "部分" : "完整分 P 列表的"}合并稿：${job.mergedDraftId}\n运行 /learn review ${job.mergedDraftId}，一次审核保存为一份文档。` : `尚未生成合并稿。${job.mergeError ?? "没有已完成章节。"}`)
          : "每 P 分别成文，运行 /learn review <草稿ID> 审核保存。";
        return { content: [{ type: "text", text: `${job.status === "completed" ? "全部分 P 处理完成" : "分 P 批量处理已停止"}：${job.title}\n本次确认完成 ${job.completed.length}/${job.total} 个 P。\n${job.completed.map(p => `${p.bvid ? `视频${p.videoIndex} ${p.bvid} / P${p.sourcePart}` : `P${p.part}`}：${p.visual ? "采样画面（无声音，非全文）" : "字幕讲义"}${p.reused ? "，已复用" : ""}${job.outputMode === "merged" && job.mergedDraftId ? "" : `；草稿 ${p.draftId}`}`).join("\n")}\n${job.error ? `停止于 ${job.stoppedLabel ?? `P${job.stoppedPart}`}：${job.error}\n未处理的分 P 不代表已学习。修复问题后由用户再次运行 /learn course ${job.origin === "manual" ? job.inputs!.join(" ") : job.bvid}；失败生成仍须 /learn retry 人工确认。\n` : ""}${output}\n课程任务ID：${job.id}\n资料合并不做语义综合；综合教程有独立预算确认，不等于完整观看或事实核验。未自动发布。` }], details, usage: result.usage };
      },
    });
    pi.registerTool({
      name: "learn_tutorial", label: "重编综合教程",
      description: "使用已缓存的课程任务、合并稿或综合任务ID，跨视频按主题选材去重并重编教程。不访问平台、不下载视频、不重传音视频。额外预算及规划必须由用户分别确认；不自动续写失败步骤或发布。",
      promptSnippet: "用户希望合并后去重综合时用 learn_tutorial；先由用户确认额外用量，不要用普通write覆盖或发布教程。",
      parameters: Type.Object({ input: Type.String({ description: "已有课程任务ID、合并草稿ID或未完成综合任务ID；不接受文件路径" }) }),
      executionMode: "sequential",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async execute(_id, params, signal, onUpdate, ctx) {
        requireUI(ctx);
        const result = await work(signal, signal => service().tutorial(params.input, modelRunner(ctx), tutorialApproval(ctx), signal,
          message => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined })));
        return { content: [{ type: "text", text: result.status === "draft"
          ? `${result.reused ? "复用已有综合教程，未再次调用模型" : "综合教程已生成"}。草稿ID：${result.draftId}\n运行 /learn review ${result.draftId} 审核保存；不是已核验事实。`
          : `综合已停止：${result.error}\n已完成规划/章节与用量保留；由用户运行 /learn tutorial ${result.jobId} 再次确认后继续，不自动重试。` }], details: result, usage: result.usage };
      },
    });
    pi.registerTool({
      name: "learn_status", label: "学习计划状态", description: "查看用户已创建的当前学习计划和草稿ID，不含账号凭据。",
      parameters: Type.Object({}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async execute() {
        const store = service().store;
        const plan = await store.activePlan();
        const drafts = (await store.list<Draft>("drafts")).filter(d => d.planId === plan.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
        const jobs = (await store.list<Record<string, unknown>>("jobs")).filter(j => j.kind === "generation" && j.planId === plan.id && ["running", "failed", "cancelled"].includes(String(j.status)));
        const details = { plan: { id: plan.id, title: plan.title, topic: plan.topic, goal: plan.goal, revision: plan.revision },
          drafts: drafts.map(d => ({ id: d.id, title: d.title, createdAt: d.createdAt, published: d.publishedPaths.length > 0 })),
          unfinishedJobs: jobs.slice(-10).map(j => ({ id: j.id, status: j.status, errorCode: j.errorCode })),
          courses: await courseStatuses(store, plan),
          tutorialJobs: (await store.list<Record<string, unknown>>("jobs")).filter(j => j.kind === "tutorial" && j.planId === plan.id && ["running", "failed", "cancelled"].includes(String(j.status)))
            .map(j => ({ id: j.id, sourceCourseId: j.sourceCourseId, status: j.status, completedChapters: Array.isArray(j.chapters) ? j.chapters.length : 0, error: j.error })) };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      },
    });

    async function authenticate(ctx: ExtensionCommandContext): Promise<void> {
      requireUI(ctx);
      if (authentication) throw new LearnError("ACCOUNT_BUSY", "已有登录流程正在进行，请完成该流程，或运行 /learn cancel 取消。");
      const task = work(ctx.signal, async signal => {
        let account: BilibiliAccount | undefined;
        let deadline: AbortSignal | undefined;
        try {
          const installed = await availableBrowsers();
          signal.throwIfAborted();
          const browsers: { label: string; browser?: BrowserKind }[] = [
            { label: "自动选择（推荐）" },
            { label: `Microsoft Edge${installed.includes("edge") ? "（已检测到）" : ""}`, browser: "edge" },
            { label: `Google Chrome${installed.includes("chrome") ? "（已检测到）" : ""}`, browser: "chrome" },
          ];
          const selected = await ctx.ui.select("选择 Bilibili 登录浏览器（只使用已安装的浏览器）", browsers.map(value => value.label), { signal });
          signal.throwIfAborted();
          const choice = browsers.find(value => value.label === selected);
          if (!choice) return;
          if (await ctx.ui.confirm("打开专用浏览器登录？", "将打开 Nibblearn 的独立登录窗口，不读取日常浏览器配置，也不下载浏览器。首次需在专用窗口登录 B 站，之后通常可复用登录状态；验证码请自行处理。\n\n登录后回到 pi，选择“我已完成登录，检查账号”，再确认昵称和 UID。确认前不会替换插件原有凭据；Cookie 不显示、不发送给模型。\n\n专用浏览器会保留登录状态，包括取消保存时。结束后只关闭本次专用窗口。本次登录最多等待 10 分钟。", { signal }) !== true) return;
          signal.throwIfAborted();
          const store = new Store(options.home);
          account = new BilibiliAccount({ browser: choice.browser, homeDirectory: store.home, credentialStore: store });
          accounts.add(account);
          deadline = AbortSignal.timeout(600000);
          const loginSignal = AbortSignal.any([signal, deadline]);
          ctx.ui.setStatus("nibblearn-auth", "正在打开专用浏览器…");
          await account.openLogin({ signal: loginSignal });
          const browser = account.getBrowserKind() === "chrome" ? "Chrome" : "Edge";
          const check = "我已完成登录，检查账号", resume = "已处理登录/验证码，恢复验证", cancel = "取消登录";
          let needsVerification = false;
          while (true) {
            loginSignal.throwIfAborted();
            ctx.ui.setStatus("nibblearn-auth", `请在专用 ${browser} 中登录，再回到 pi 检查账号`);
            const action = await ctx.ui.select(`请在刚打开的 ${browser} 窗口完成 B 站登录，再选择检查账号。遇到验证码请手动处理，无需找 Cookie。`, needsVerification ? [check, resume, cancel] : [check, cancel], { signal: loginSignal });
            loginSignal.throwIfAborted();
            if (action !== check && action !== resume) return;
            try {
              if (action === resume && !await account.resumeAfterManualVerification(approvalSignal => ctx.ui.confirm("确认已手动处理登录或验证码？", "请先在专用浏览器中完成登录或验证码，再确认继续。只解除本地人工暂停，不会清除平台要求的等待时间。", { signal: approvalSignal }), { signal: loginSignal })) continue;
              ctx.ui.setStatus("nibblearn-auth", "正在验证 Bilibili 账号…");
              const result = await account.authorizeAndSave((identity, approvalSignal) => ctx.ui.confirm("确认使用这个 Bilibili 账号？", `昵称：${identity.name}\nUID：${identity.uid}\n\n确认后将替换本插件的本机登录凭据。凭据文件不加密，依赖当前系统用户权限；不会发送给模型或聊天。\n\n若账号不是你想使用的，请取消，然后重新运行 /learn auth。`, { signal: approvalSignal }), { signal: loginSignal });
              ctx.ui.notify(result.saved ? "Bilibili 登录态已保存。现在可以运行 /learn video <链接或BV号>；登录失效时重新运行 /learn auth。" : "未保存新的插件凭据，原有凭据保持不变。专用浏览器的登录状态仍会保留。", "info");
              return;
            } catch (error) {
              if (!(error instanceof LearnError) || !["ACCOUNT_LOGIN_REQUIRED", "ACCOUNT_VERIFICATION", "ACCOUNT_PAUSED", "ACCOUNT_CHANGED"].includes(error.code)) throw error;
              needsVerification ||= ["ACCOUNT_VERIFICATION", "ACCOUNT_PAUSED"].includes(error.code);
              ctx.ui.notify(publicError(error), "warning");
              // Only an explicit user action retries or resumes; there is no background polling.
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          if (deadline?.aborted) throw new LearnError("ACCOUNT_TIMEOUT", "本次登录已超过 10 分钟，请重新运行 /learn auth。没有持续后台轮询。");
          throw error;
        } finally {
          try { if (account) await account.close(); }
          finally {
            if (account) accounts.delete(account);
            ctx.ui.setStatus("nibblearn-auth", undefined);
          }
        }
      });
      authentication = task;
      try { await task; }
      finally { if (authentication === task) authentication = undefined; }
    }

    async function setup(ctx: ExtensionCommandContext): Promise<void> {
      requireUI(ctx);
      const title = await ctx.ui.input("学习计划名称（任意主题）", "例如：摄影入门、世界历史、某项技能");
      if (title === undefined) return;
      const topic = await ctx.ui.input("想学什么？", title);
      if (topic === undefined) return;
      const goal = await ctx.ui.input("希望理解或完成什么？", "写出你的学习目标");
      if (goal === undefined) return;
      const output = await ctx.ui.input("成品保存到哪个文件夹？", "绝对路径或相对于当前工作目录的路径");
      if (output === undefined) return;
      const background = await ctx.ui.input("已有基础（可留空）");
      if (background === undefined) return;
      const focus = await ctx.ui.input("希望覆盖/排除什么（可留空）");
      if (focus === undefined) return;
      const noteStyle = await ctx.ui.input("笔记形式", "概念解释、要点、例子与自测");
      if (noteStyle === undefined) return;
      const language = await ctx.ui.input("输出语言", "zh-CN");
      if (language === undefined) return;
      const supplement = await ctx.ui.select("没有参考材料支持时，是否允许明确标记为未核验的模型解释？", ["允许，单独标注", "不允许，只整理材料"]);
      if (!supplement) return;
      const outputDir = expandPath(output, ctx.cwd);
      if (!await ctx.ui.confirm("确认计划与模型数据传输", `主题：${topic}\n目标：${goal}\n目录：${outputDir}\n\n字幕、学习目标和主动提供的参考材料将发送给 pi 当前模型服务，并消耗相应额度。账号 Cookie 不发送给模型。是否同意并创建计划？`)) return;
      const store = service().store;
      const plan = validatePlan({ schemaVersion: 1, id: store.newPlanId(), revision: 1, title, topic, goal, background, focus,
        noteStyle: noteStyle || "概念解释、要点、例子与自测", language: language || "zh-CN", outputDir: await ensureDirectory(outputDir),
        allowModelSupplement: supplement.startsWith("允许"), consentModelTransfer: true, references: [] });
      await store.savePlan(plan);
      await store.selectPlan(plan.id);
      report(`学习计划已创建：**${plan.title}**（${plan.id}）\n保存目录：${plan.outputDir}\n接下来运行 /learn video <链接>，或 /learn import <字幕文件>。`);
    }
    async function configure(ctx: ExtensionCommandContext): Promise<void> {
      requireUI(ctx);
      const store = service().store, current = await store.activePlan();
      const edited = await ctx.ui.editor("编辑当前学习计划（不在这里填写凭据）", JSON.stringify(current, null, 2));
      if (edited === undefined) return;
      const next = validatePlan(parseJson(edited));
      if (next.id !== current.id || next.revision !== current.revision) throw new LearnError("INVALID_PLAN", "不能在编辑器修改计划 ID 或 revision。");
      if (!await ctx.ui.confirm("确认修改计划", `目标：${next.goal}\n保存目录：${next.outputDir}\n将创建新版本，旧草稿保留但不自动迁移或发布。`)) return;
      next.outputDir = await ensureDirectory(next.outputDir);
      const saved = await store.savePlan(next);
      report(`计划已更新：${saved.title}，版本 ${saved.revision}。旧文件未被修改。`);
    }
    async function chooseDraft(ctx: ExtensionCommandContext, key: string): Promise<Draft | undefined> {
      const store = service().store;
      if (key) return store.draft(key);
      const plan = await store.activePlan();
      const drafts = (await store.list<Draft>("drafts")).filter(d => d.planId === plan.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (!drafts.length) throw new LearnError("NO_DRAFT", "还没有草稿，请先处理一个视频或导入字幕。");
      const choices = drafts.slice(0, 30).map(d => `${d.id} | ${d.title}`);
      const selected = await ctx.ui.select("选择草稿", choices);
      return selected ? store.draft(selected.split(" | ")[0]!) : undefined;
    }
    async function review(ctx: ExtensionCommandContext, key: string): Promise<void> {
      requireUI(ctx);
      const draft = await chooseDraft(ctx, key);
      if (!draft) return;
      const store = service().store, plan = await store.activePlan();
      if (plan.id !== draft.planId || plan.revision !== draft.planRevision) throw new LearnError("PLAN_CHANGED", "该草稿不是当前计划版本，请重新生成或切回对应计划。");
      const edited = await ctx.ui.editor("预览/编辑草稿；退出后还需确认成品保存", draft.markdown);
      if (edited === undefined) return;
      if (!edited.trim()) throw new LearnError("INVALID_DRAFT", "草稿不能为空。");
      await store.updateDraft({ ...draft, markdown: edited });
      if (!await ctx.ui.confirm("保存到指定目录？", `计划：${plan.title}\n目标目录：${plan.outputDir}\n文件：${draft.title}\n\n已有文件不会被覆盖；同名且内容不同会新增版本。取消仍保留本地草稿。`)) return;
      const destination = await service().publish(draft.id, edited);
      report(`已保存：${destination}`);
    }

    pi.registerCommand("learn", {
      description: "Nibblearn：学习计划与视频材料笔记，setup / auth / video / course / tutorial / import / review",
      getArgumentCompletions(prefix) {
        return ["setup", "plans", "use", "config", "auth", "video", "course", "tutorial", "import", "reference", "review", "save", "status", "retry", "resume", "cancel"]
          .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
      },
      async handler(args, ctx) {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
        const command = match?.[1] ?? "help", argument = (match?.[2] ?? "").trim();
        try {
          if (command === "help") { report(HELP); return; }
          if (command === "setup") { await setup(ctx); return; }
          if (command === "config") { await configure(ctx); return; }
          if (command === "auth") { await authenticate(ctx); return; }
          if (command === "cancel") {
            for (const controller of controllers) controller.abort();
            ctx.ui.notify("已请求取消本插件任务；取消不会发布文件。", "info"); return;
          }
          if (command === "review" || command === "save") { await review(ctx, argument); return; }
          const store = service().store;
          if (command === "plans" || command === "use") {
            requireUI(ctx);
            let key = argument;
            if (!key) {
              const plans = (await store.list<Plan>("plans")).map(validatePlan);
              if (!plans.length) throw new LearnError("NO_PLAN", "请先运行 /learn setup。");
              const choice = await ctx.ui.select("选择学习计划", plans.map(p => `${p.id} | ${p.title}`));
              if (!choice) return;
              key = choice.split(" | ")[0]!;
            }
            report(`当前计划：${(await store.selectPlan(key)).title}`); return;
          }
          if (command === "resume") {
            requireUI(ctx);
            if (await ctx.ui.confirm("人工确认", "你是否已在浏览器处理登录失效或验证码？只解除账号人工暂停，不会清除平台要求的等待时间。")) await service().provider.resume();
            return;
          }
          if (command === "retry") {
            requireUI(ctx);
            if (!await ctx.ui.confirm("确认重新消耗模型额度？", "将重试这个未完成任务，从头整理材料；过去已消耗的用量记录保留，不会自动发布文件。")) return;
            const materialId = await service().approveRetry(argument);
            pi.sendUserMessage(`用户已确认重试。请仅调用 learn_generate，input=${JSON.stringify(materialId)}，不要自动发布。`, { deliverAs: "followUp" });
            return;
          }
          if (command === "reference") {
            requireUI(ctx);
            const plan = await store.activePlan(), file = expandPath(argument, ctx.cwd);
            if (![".md", ".txt"].includes(path.extname(file).toLowerCase())) throw new LearnError("UNSUPPORTED_FILE", "参考资料仅接受 .md 或 .txt；不要选择凭据文件。");
            const content = await readText(file, 32000);
            const reference = { id: `ref-${hash(content).slice(0, 16)}`, title: path.basename(file), text: content };
            if (!await ctx.ui.confirm("添加参考材料？", `${reference.title}\n共 ${content.length} 字符，之后会发送给当前模型。请确认不含凭据或不愿共享的隐私。`)) return;
            await store.savePlan({ ...plan, references: [...plan.references.filter(r => r.id !== reference.id), reference] });
            report("参考材料已添加，计划版本已更新。此操作没有检索网页，也没有认证资料权威性。"); return;
          }
          if (command === "tutorial") {
            const key = argument.trim();
            if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new LearnError("INVALID_ID", "请提供课程或草稿ID，不要提供文件路径。");
            pi.sendUserMessage(`请仅调用 learn_tutorial，input=${JSON.stringify(key)}。额外用量及规划由工具内对话框确认；停止后不要自动重试，不要用write发布。`, { deliverAs: "followUp" });
            return;
          }
          if (command === "video" || command === "course") {
            const plan = await store.activePlan(); service().checkConsent(plan);
            const input = command === "course" ? parseCourseInputs(argument).join(" ") : parseVideo(argument).url;
            pi.sendUserMessage(`请仅调用 ${command === "course" ? "learn_course" : "learn_video"} 工具生成草稿，input=${JSON.stringify(input)}。${command === "course" ? "通过工具内对话框确认当前视频、投稿合集或多链接范围；停止后不要自动重试或改用单 P 工具继续。" : ""}完成后告知 /learn review，不要用 write 等工具发布或访问凭据。`, { deliverAs: "followUp" });
            return;
          }
          if (command === "import") {
            requireUI(ctx);
            const plan = await store.activePlan(); service().checkConsent(plan);
            const material = await importSubtitle(expandPath(argument, ctx.cwd));
            if (!await ctx.ui.confirm("导入并整理字幕？", `${material.title}，共 ${material.segments.length} 段。内容将发送给当前模型；未执行任何 Bilibili 请求。`)) return;
            const saved = await store.saveMaterial(material);
            pi.sendUserMessage(`请仅调用 learn_generate 工具生成草稿，input=${JSON.stringify(saved.id)}。完成后告知 /learn review，不要自动发布。`, { deliverAs: "followUp" });
            return;
          }
          if (command === "status") {
            const plan = await store.activePlan();
            const drafts = (await store.list<Draft>("drafts")).filter(d => d.planId === plan.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
            const jobs = (await store.list<Record<string, unknown>>("jobs")).filter(j => j.kind === "generation" && j.planId === plan.id && ["running", "failed", "cancelled"].includes(String(j.status)));
            const courses = await courseStatuses(store, plan);
            const tutorials = (await store.list<Record<string, unknown>>("jobs")).filter(j => j.kind === "tutorial" && j.planId === plan.id && ["running", "failed", "cancelled"].includes(String(j.status)));
            if (tutorials.length) report(`未完成教程综合（需再次确认用量，不自动重试）：\n${tutorials.map(j => `- ${j.id}：${j.status}，已保存 ${Array.isArray(j.chapters) ? j.chapters.length : 0} 章；${j.error ?? ""}`).join("\n")}\n运行 /learn tutorial <任务ID> 可人工确认后继续。`);
            if (courses.length) report(`分 P 课程进度（running 也可能是上次退出遗留，不代表正在执行）：\n${courses.map(c => `- ${c.bvid}：${c.completed}/${c.total}，${c.status}${c.stoppedPart ? `，停止于 ${c.stoppedLabel ?? `P${c.stoppedPart}`}` : ""}${c.error ? `；${c.error}` : ""}${c.mergedDraftId ? `；合并稿 ${c.mergedDraftId}` : ""}${c.mergeError ? `；合并失败：${c.mergeError}` : ""}${c.origin === "manual" ? `；继续输入：/learn course ${c.inputs!.join(" ")}` : ""}`).join("\n")}\n由用户运行 /learn course <BV号或多个链接> 确认后继续；已完成项可复用。`);
            report(`当前计划：${plan.title}（${plan.id}，v${plan.revision}）\n主题：${plan.topic}\n目标：${plan.goal}\n保存目录：${plan.outputDir}\n本插件凭据：${await store.hasCredentials() ? "已配置（未在线验证）" : "未配置，可先导入字幕"}\n\n最近草稿：\n${drafts.map(d => `- ${d.id}：${d.title}${d.publishedPaths.length ? "（已保存）" : "（待审核）"}`).join("\n") || "暂无"}\n\n未完成任务（需 /learn retry 人工重试）：\n${jobs.slice(-10).map(j => `- ${j.id}：${j.status} ${j.errorCode ?? ""}`).join("\n") || "暂无"}`);
            return;
          }
          throw new LearnError("UNKNOWN_COMMAND", "未知命令，运行 /learn 查看用法。");
        } catch (error) { ctx.ui.notify(publicError(error), "error"); }
      },
    });
  };
}
export default createLearnExtension();
