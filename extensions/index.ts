import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BilibiliProvider, parseVideo } from "../src/bilibili.ts";
import { ensureDirectory, expandPath, readText } from "../src/files.ts";
import { Store } from "../src/store.ts";
import { LearnService } from "../src/service.ts";
import { importSubtitle } from "../src/subtitles.ts";
import { LearnError, ModelRunError, publicError } from "../src/types.ts";
import type { Draft, ModelRunner, Plan } from "../src/types.ts";
import { hash, parseJson, validatePlan } from "../src/validate.ts";

const HELP = `# Nibblearn · 啃啃学 · /learn

- setup：创建任意主题的学习计划，选择保存目录
- plans / use <ID>：选择学习计划
- config：编辑当前计划（修改会产生新版本）
- auth：在本地对话框配置 Bilibili Cookie，**不要发到聊天里**
- video <BV号或完整链接>：按当前计划整理字幕，只生成草稿
- import <字幕文件路径>：导入 SRT/VTT/JSON 后生成草稿，不必登录 Bilibili
- reference <文本文件路径>：添加用户提供的参考材料（.md/.txt，最多8000字符）
- review [草稿ID] / save [草稿ID]：预览、编辑，确认后保存；绝不覆盖已有文件
- status：查看计划、最近草稿与失败任务
- retry <任务ID>：人工确认后重试失败或中断任务
- resume：人工处理登录/验证码后解除本地账号暂停，不绕过平台退避
- cancel：取消本插件正在执行的任务

使用 pi 当前模型和认证。字幕、学习目标、参考材料会发送给该模型服务。
第一版仅依据字幕；未浏览网页、未分析画面、无内置 ASR。不自动评论、私信、点赞或播放视频。`;

function requireUI(ctx: ExtensionContext): void {
  if (!ctx.hasUI) throw new LearnError("UI_REQUIRED", "此操作需要交互确认，请在 pi 终端或支持对话框的 RPC 客户端运行。");
}
function modelRunner(ctx: ExtensionContext): ModelRunner {
  const model = ctx.model;
  if (!model) throw new LearnError("NO_MODEL", "请先在 pi 中选择并登录一个模型。");
  return async request => {
    const maxTokens = Math.min(request.maxTokens, model.maxTokens || request.maxTokens);
    // UTF-8 bytes deliberately overestimate input tokens. Never silently truncate a course.
    if (Buffer.byteLength(request.system + request.prompt, "utf8") + maxTokens + 1024 > model.contextWindow) {
      throw new LearnError("MODEL_CONTEXT", "当前模型上下文不足，请选择更大上下文模型、减少参考资料或拆分字幕；未截断材料。");
    }
    let response;
    try {
      response = await ctx.modelRegistry.streamSimple(model, {
        systemPrompt: request.system,
        messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
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
}

export function createLearnExtension(options: { home?: string; transport?: typeof fetch } = {}) {
  return function nibblearnPi(pi: ExtensionAPI): void {
    // Registration only. Do not read credentials, create directories or start timers on load.
    const controllers = new Set<AbortController>();
    const service = () => {
      const store = new Store(options.home);
      return new LearnService(store, new BilibiliProvider(store, options.transport));
    };
    const report = (content: string) => pi.sendMessage({ customType: "nibblearn", content, display: true });
    const work = async <T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      controllers.add(controller);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try { return await action(combined); } finally { controllers.delete(controller); }
    };
    pi.on("session_shutdown", async () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    });

    const toolOutput = Type.Object({ draftId: Type.String(), title: Type.String(), reused: Type.Boolean() });
    const generateTool = (kind: "video" | "material") => {
      pi.registerTool({
        name: kind === "video" ? "learn_video" : "learn_generate",
        label: kind === "video" ? "学习视频字幕" : "整理已导入字幕",
        description: kind === "video"
          ? "按用户已确认的当前学习计划读取一个 Bilibili 视频（支持 ?p= 指定分 P），调用当前模型生成带证据的本地草稿。无平台写操作，不发布成品。"
          : "按当前学习计划整理 /learn import 已导入的材料 ID。不会读取任意文件，不发布成品。",
        promptSnippet: "按用户学习计划生成有来源的字幕笔记草稿；成品保存须由用户运行 /learn review 确认。",
        promptGuidelines: ["不得索要或通过 read/bash 获取 Cookie；用户用 /learn auth 本地配置。", "草稿不是已核验事实，不使用普通 write 工具绕过 /learn review 发布。"],
        parameters: Type.Object({ input: Type.String({ description: kind === "video" ? "BV号或完整HTTPS视频链接，分P用?p=2" : "已导入的材料ID" }) }),
        outputSchema: toolOutput,
        executionMode: "sequential",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const svc = service();
          const run = modelRunner(ctx);
          const result = await work(signal, async signal => {
            const progress = (message: string) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
            return kind === "video" ? svc.fromVideo(params.input, run, signal, progress) : svc.fromMaterial(params.input, run, signal, progress);
          });
          const details = { draftId: result.draft.id, title: result.draft.title, reused: result.reused };
          return {
            content: [{ type: "text", text: `${result.reused ? "复用已有草稿（未再次调用整理模型）" : "草稿已生成"}：${result.draft.title}\n草稿ID：${result.draft.id}\n尚未写入成品目录。用户运行 /learn review ${result.draft.id} 预览并确认保存。` }],
            structuredContent: details, details, usage: result.usage,
          };
        },
      });
    };
    generateTool("video");
    generateTool("material");
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
          unfinishedJobs: jobs.slice(-10).map(j => ({ id: j.id, status: j.status, errorCode: j.errorCode })) };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      },
    });

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
      description: "Nibblearn 啃啃学：用户自定义学习目标与保存目录，setup / video / import / review",
      getArgumentCompletions(prefix) {
        return ["setup", "plans", "use", "config", "auth", "video", "import", "reference", "review", "save", "status", "retry", "resume", "cancel"]
          .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
      },
      async handler(args, ctx) {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
        const command = match?.[1] ?? "help", argument = (match?.[2] ?? "").trim();
        try {
          if (command === "help") { report(HELP); return; }
          if (command === "setup") { await setup(ctx); return; }
          if (command === "config") { await configure(ctx); return; }
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
          if (command === "auth") {
            requireUI(ctx);
            const value = await ctx.ui.editor("仅本地保存：从浏览器开发者工具复制 Cookie 值，不要发进聊天。留空取消；不会显示旧凭据。", JSON.stringify({ sessdata: "", bili_jct: "", buvid3: "" }, null, 2));
            if (value === undefined) return;
            if (!await ctx.ui.confirm("保存本机登录态？", "这将替换本插件的凭据文件，不会发送给模型。文件不加密，继承本机用户权限；输入框也不提供密码遮罩。确认没有在录屏或不受信任的 RPC 客户端中操作。")) return;
            await store.saveCredentials(parseJson(value));
            ctx.ui.notify("凭据已保存；未请求 Bilibili，也未回显 Cookie。", "info"); return;
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
          if (command === "video") {
            const plan = await store.activePlan(); service().checkConsent(plan);
            const video = parseVideo(argument);
            pi.sendUserMessage(`请仅调用 learn_video 工具生成草稿，input=${JSON.stringify(video.url)}。完成后告知 /learn review，不要用 write 等工具发布或访问凭据。`, { deliverAs: "followUp" });
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
