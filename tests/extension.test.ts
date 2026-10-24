import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createLearnExtension } from "../extensions/index.ts";
import { fixture, fakeModel } from "./helpers.ts";

type Command = { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };
function harness(home: string) {
  const commands = new Map<string, Command>(), tools = new Map<string, ToolDefinition>();
  const messages: string[] = [], prompts: string[] = [], notices: string[] = [];
  const handlers = new Map<string, () => Promise<void>>();
  const api = {
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(event: string, handler: () => Promise<void>) { handlers.set(event, handler); },
    sendMessage(message: { content: string }) { messages.push(message.content); },
    sendUserMessage(prompt: string) { prompts.push(prompt); },
  } as unknown as ExtensionAPI;
  createLearnExtension({ home })(api);
  const run = fakeModel();
  const context = {
    hasUI: true, mode: "rpc", cwd: path.dirname(home), model: { id: "fake-model", contextWindow: 200000, maxTokens: 8000 },
    modelRegistry: { streamSimple(_model: unknown, input: { systemPrompt: string; messages: { content: { text: string }[] }[] }, options: { maxTokens: number; signal?: AbortSignal }) {
      return { result: async () => {
        const result = await run({ system: input.systemPrompt, prompt: input.messages[0]!.content[0]!.text, maxTokens: options.maxTokens, signal: options.signal });
        return { content: [{ type: "text", text: result.text }], stopReason: "stop", usage: result.usage };
      } };
    } },
    ui: { notify(message: string) { notices.push(message); }, confirm: async () => true,
      editor: async (_title: string, content: string) => content, select: async (_title: string, values: string[]) => values[0] },
  } as unknown as ExtensionCommandContext;
  return { commands, tools, messages, prompts, notices, handlers, context };
}

test("插件注册不访问状态、凭据或网络，不暴露平台写工具", async () => {
  const f = await fixture();
  try {
    const home = path.join(f.root, "absent");
    const h = harness(home);
    assert.deepEqual([...h.tools.keys()].sort(), ["learn_generate", "learn_status", "learn_video"]);
    assert.ok(h.commands.has("learn")); assert.ok(h.handlers.has("session_shutdown"));
    await assert.rejects(fs.access(home), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});
test("/learn video排队调用工具，不依赖独立模型密钥或自动发布", async () => {
  const f = await fixture();
  try {
    const h = harness(f.home);
    await h.commands.get("learn")!.handler("video BV1GJ411x7h7", h.context);
    assert.equal(h.prompts.length, 1); assert.match(h.prompts[0]!, /learn_video/);
    assert.match(h.prompts[0]!, /不要用 write/);
    assert.deepEqual(await fs.readdir(f.outputDir), []);
  } finally { await f.cleanup(); }
});
test("工具调用pi当前模型，回报嵌套用量，输出仅为待审核草稿", async () => {
  const f = await fixture();
  try {
    const h = harness(f.home);
    const result = await h.tools.get("learn_generate")!.execute("fake-call", { input: f.material.id }, undefined, undefined, h.context as unknown as ExtensionToolContext);
    assert.equal(result.usage?.totalTokens, 150);
    assert.equal((result.structuredContent as { reused: boolean }).reused, false);
    assert.match(result.content.map(c => c.type === "text" ? c.text : "").join(""), /尚未写入成品目录/);
    assert.deepEqual(await fs.readdir(f.outputDir), []);
  } finally { await f.cleanup(); }
});
test("review确认后保存，非交互模式不能绕过确认", async () => {
  const f = await fixture();
  try {
    const h = harness(f.home), command = h.commands.get("learn")!;
    const result = await h.tools.get("learn_generate")!.execute("fake-call", { input: f.material.id }, undefined, undefined, h.context as unknown as ExtensionToolContext);
    const draftId = (result.structuredContent as { draftId: string }).draftId;
    await command.handler(`review ${draftId}`, { ...h.context, hasUI: false, mode: "print" });
    assert.match(h.notices.at(-1)!, /UI_REQUIRED/);
    assert.deepEqual(await fs.readdir(f.outputDir), []);
    await command.handler(`review ${draftId}`, h.context);
    assert.match(h.messages.at(-1)!, /已保存/);
    assert.deepEqual(await fs.readdir(f.outputDir), [f.plan.id]);
  } finally { await f.cleanup(); }
});
test("用户取消确认时只保留草稿，不写入成品目录", async () => {
  const f = await fixture();
  try {
    const h = harness(f.home);
    const result = await h.tools.get("learn_generate")!.execute("fake-call", { input: f.material.id }, undefined, undefined, h.context as unknown as ExtensionToolContext);
    const ctx = { ...h.context, ui: { ...h.context.ui, confirm: async () => false } };
    await h.commands.get("learn")!.handler(`save ${(result.structuredContent as { draftId: string }).draftId}`, ctx);
    assert.deepEqual(await fs.readdir(f.outputDir), []);
  } finally { await f.cleanup(); }
});
test("auth对话框存本地凭据，不进入聊天、工具结果或通知", async () => {
  const f = await fixture();
  try {
    const h = harness(f.home);
    const ctx = { ...h.context, ui: { ...h.context.ui, editor: async () => JSON.stringify({ sessdata: "LOCAL_FAKE_SECRET", bili_jct: "LOCAL_FAKE_JCT" }) } };
    await h.commands.get("learn")!.handler("auth", ctx);
    assert.equal((await f.store.credentials()).sessdata, "LOCAL_FAKE_SECRET");
    assert.equal(JSON.stringify([h.messages, h.prompts, h.notices]).includes("LOCAL_FAKE_SECRET"), false);
    assert.equal(JSON.stringify([h.messages, h.prompts, h.notices]).includes("LOCAL_FAKE_JCT"), false);
  } finally { await f.cleanup(); }
});
test("关闭或切换会话时取消进行中的嵌套模型工作", async () => {
  const f = await fixture();
  try {
    const h = harness(f.home);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const ctx = { ...h.context, modelRegistry: { streamSimple: (_model: unknown, _input: unknown, options: { signal: AbortSignal }) => ({ result: async () => {
      started();
      await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
    } }) } } as unknown as ExtensionToolContext;
    const execution = h.tools.get("learn_generate")!.execute("fake-call", { input: f.material.id }, undefined, undefined, ctx);
    await ready; await h.handlers.get("session_shutdown")!();
    await assert.rejects(execution);
    assert.equal((await f.store.list("drafts")).length, 0);
  } finally { await f.cleanup(); }
});
