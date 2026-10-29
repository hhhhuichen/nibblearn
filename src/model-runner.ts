import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LearnError, ModelRunError } from "./types.ts";
import type { ModelRunDiagnostics, ModelRunner } from "./types.ts";

/** One request only. Recovery and extra spending always require the caller's user approval. */
export function modelRunner(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): ModelRunner {
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
    // Keep the same conservative estimate; the extra capacity hint fits inside this margin.
    const inputBudget = Buffer.byteLength(request.system + request.prompt, "utf8") + images.length * 8192 + 1024;
    const availableOutput = model.contextWindow - inputBudget;
    if (availableOutput < 1) {
      throw new LearnError("MODEL_CONTEXT", "当前模型上下文不足，请选择更大上下文模型、减少参考资料或拆分字幕；未截断材料。");
    }
    const maxTokens = Math.min(request.maxTokens ?? model.maxTokens, model.maxTokens, availableOutput);
    const capacityHint = `\n输出容量提示：本次最多 ${maxTokens} tokens，推理可能也占用此预算。不要写满上限；若要求 JSON，须在预算内返回完整对象及全部必需字段。优先减少重复解释，不删掉必要条件、推导或证据，不输出半个对象。`;
    const content = [{ type: "text" as const, text: request.prompt }, ...images.map(image => ({ type: "image" as const, ...image }))];
    const context = { systemPrompt: request.system + capacityHint, messages: [{ role: "user" as const, content, timestamp: Date.now() }] };
    if (model.inputLimits?.maxRequestBytes && Buffer.byteLength(JSON.stringify(context), "utf8") + 4096 > model.inputLimits.maxRequestBytes) {
      throw new LearnError("MODEL_REQUEST_SIZE", "图文请求超过当前模型的请求大小上限，没有截断图片。");
    }
    const diagnostics = (stopReason: ModelRunDiagnostics["stopReason"]): ModelRunDiagnostics => ({
      stopReason, maxTokens, modelMaxTokens: model.maxTokens, contextWindow: model.contextWindow, estimatedInputTokens: inputBudget,
    });
    let response;
    try {
      // No tools, session history or provider retry loop are supplied here.
      response = await ctx.modelRegistry.streamSimple(model, context,
        { signal: request.signal, maxTokens, cacheRetention: "none" }).result();
    } catch {
      if (request.signal?.aborted) throw request.signal.reason;
      throw new ModelRunError("MODEL_REQUEST_FAILED", "当前模型调用失败，请检查 pi 的模型连接；没有自动重试，未回显服务端请求详情。", undefined, diagnostics("request_failed"));
    }
    if (response.stopReason === "aborted") throw new DOMException("Cancelled", "AbortError");
    if (response.stopReason === "length") {
      throw new ModelRunError("MODEL_OUTPUT_LIMIT", `模型达到本次输出上限（${maxTokens} tokens），输出未完成。请缩小编写范围或调整模型后人工确认继续；没有发布半成品或自动重试。`, response.usage, diagnostics("length"));
    }
    if (response.stopReason === "error") {
      throw new ModelRunError("MODEL_RESPONSE_ERROR", "模型返回 error 结束状态，不等同于输出超限。请检查模型服务或适配层后人工确认继续；未记录底层错误原文。", response.usage, diagnostics("error"));
    }
    if (response.stopReason !== "stop") {
      throw new ModelRunError("MODEL_INCOMPLETE", "模型以非预期方式结束；本任务不提供工具，未采用不完整输出。请人工确认后继续。", response.usage,
        diagnostics(response.stopReason === "toolUse" ? "toolUse" : "unknown"));
    }
    const output = response.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (!output.trim()) throw new ModelRunError("MODEL_EMPTY_OUTPUT", "模型正常结束但没有返回正文；未发布或自动重试。", response.usage, diagnostics("stop"));
    return { text: output, usage: response.usage };
  };
  run.supportsImages = model.input.includes("image");
  run.maxImagesPerRequest = imageLimit;
  return run;
}
