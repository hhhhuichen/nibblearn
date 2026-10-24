import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fixture, fakeModel, materialWith, usage } from "./helpers.ts";
import { parseSubtitleFile } from "../src/subtitles.ts";
import { LearnService } from "../src/service.ts";
import { modelPrompt, parseNotes, splitSegments, timestamp } from "../src/notes.ts";
import { validateCredentials, validatePlan } from "../src/validate.ts";

const withFixture = (name: string, action: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) => test(name, async () => {
  const f = await fixture(); try { await action(f); } finally { await f.cleanup(); }
});

test("导入 SRT 保留起止时间与多行内容", () => {
  const value = parseSubtitleFile("1\r\n00:00:01,250 --> 00:00:03,500\r\n第一行\r\n第二行\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\n结尾", ".srt");
  assert.deepEqual(value, [{ start: 1.25, end: 3.5, text: "第一行\n第二行" }, { start: 5, end: 6, text: "结尾" }]);
});
test("导入 VTT 和平台 JSON，不忽略损坏的段落", () => {
  assert.equal(parseSubtitleFile("WEBVTT\n\n00:01.000 --> 00:02.000 align:start\n<b>你好</b>\n", ".vtt")[0]!.text, "你好");
  assert.equal(parseSubtitleFile('{"body":[{"from":1,"to":3,"content":"你好"}]}', ".json")[0]!.end, 3);
  assert.throws(() => parseSubtitleFile("1\n00:00:02,000 --> 00:00:01,000\n倒序", ".srt"));
  assert.throws(() => parseSubtitleFile("没有时间轴", ".srt"));
  assert.throws(() => parseSubtitleFile("secret", ".env"));
});
test("凭据拒绝 Header 注入、分号及缺失登录态", () => {
  assert.throws(() => validateCredentials({ sessdata: "abc\r\nCookie: bad" }));
  assert.throws(() => validateCredentials({ sessdata: "abc;other=x" }));
  assert.throws(() => validateCredentials({}));
  assert.deepEqual(validateCredentials({ sessdata: "example" }), { sessdata: "example", bili_jct: "", buvid3: "" });
});
test("分块不遗漏字幕、不重新编号，也不静默截断单条长文本", () => {
  const segments = Array.from({ length: 50 }, (_, i) => ({ start: i, end: i + 1, text: "内容".repeat(30) }));
  const chunks = splitSegments(segments, 1000);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat().map(s => s.index), segments.map((_, i) => i));
  assert.throws(() => splitSegments([{ start: 0, end: 1, text: "x".repeat(2000) }], 1000));
  assert.equal(timestamp(3661), "01:01:01");
});

withFixture("生成草稿、按目标引用原文、审核后保存，重跑不重复调用模型", async f => {
  const calls: string[] = [], service = new LearnService(f.store);
  const result = await service.fromMaterial(f.material.id, fakeModel(calls));
  assert.equal(calls.length, 1);
  assert.equal(result.draft.usage.totalTokens, 150);
  assert.match(result.draft.markdown, /00:00–00:05/);
  assert.match(result.draft.markdown, /模型解释，未检索核验/);
  assert.match(result.draft.markdown, /光圈决定进光量/);
  assert.deepEqual(await fs.readdir(f.outputDir), []);
  const published = await service.publish(result.draft.id);
  assert.equal(await fs.readFile(published, "utf8"), result.draft.markdown);
  const second = await service.fromMaterial(f.material.id, fakeModel(calls));
  assert.equal(second.reused, true); assert.equal(calls.length, 1); assert.equal(second.usage.totalTokens, 0);
  assert.equal(await service.publish(result.draft.id), published);
});
withFixture("人工编辑的成品不覆盖，之后保存新增版本", async f => {
  const service = new LearnService(f.store);
  const { draft } = await service.fromMaterial(f.material.id, fakeModel());
  const first = await service.publish(draft.id);
  await fs.writeFile(first, "用户亲自修改的内容");
  const second = await service.publish(draft.id);
  assert.notEqual(first, second); assert.match(second, /--v2\.md$/);
  assert.equal(await fs.readFile(first, "utf8"), "用户亲自修改的内容");
});
withFixture("同一材料换学习目标会重新解读，旧版本草稿不发布到新位置", async f => {
  const calls: string[] = [], service = new LearnService(f.store);
  const old = await service.fromMaterial(f.material.id, fakeModel(calls));
  await f.store.savePlan({ ...f.plan, topic: "历史", goal: "比较不同叙述的证据与立场" });
  const next = await service.fromMaterial(f.material.id, fakeModel(calls));
  assert.notEqual(old.draft.id, next.draft.id); assert.equal(calls.length, 2);
  assert.match(calls[1]!, /历史/);
  await assert.rejects(service.publish(old.draft.id), /计划或版本/);
});
withFixture("没有数据传输许可时，不调用模型", async f => {
  await f.store.savePlan({ ...f.plan, consentModelTransfer: false });
  const calls: string[] = [];
  await assert.rejects(new LearnService(f.store).fromMaterial(f.material.id, fakeModel(calls)), /允许将字幕/);
  assert.equal(calls.length, 0);
});
withFixture("模型看不到保存目录、Cookie 或完整会话", async f => {
  await f.store.saveCredentials({ sessdata: "SUPER_SECRET", bili_jct: "OTHER_SECRET" });
  const prompt = modelPrompt(f.plan, f.material, splitSegments(f.material.segments)[0]!, 1, 1);
  assert.equal(prompt.includes(f.outputDir), false);
  assert.equal(prompt.includes("SUPER_SECRET"), false);
  assert.equal(prompt.includes("OTHER_SECRET"), false);
  assert.equal(prompt.includes("credentials"), false);
});
withFixture("模型虚构时间戳证据时拒绝草稿，保留已消耗用量记录", async f => {
  const service = new LearnService(f.store);
  await assert.rejects(service.fromMaterial(f.material.id, async () => ({ text: JSON.stringify({ overview: "ok", points: [{ heading: "假证据", explanation: "x", evidence: [999] }], supplements: [], questions: [], caveats: [] }), usage })), /不存在的字幕索引/);
  assert.equal((await f.store.list("drafts")).length, 0);
  const jobs = await f.store.list<{ status: string; usage: { totalTokens: number } }>("jobs");
  assert.equal(jobs[0]!.status, "failed"); assert.equal(jobs[0]!.usage.totalTokens, 150);
  assert.deepEqual(await fs.readdir(f.outputDir), []);
});
withFixture("参考材料来源必须存在；禁止模型补充时不能偷偷补充", async f => {
  const raw = { overview: "ok", points: [], supplements: [{ text: "补充", referenceIds: ["不存在"] }], questions: [], caveats: [] };
  assert.throws(() => parseNotes(JSON.stringify(raw), splitSegments(f.material.segments)[0]!, f.plan), /未提供的参考资料/);
  raw.supplements[0]!.referenceIds = [];
  assert.throws(() => parseNotes(JSON.stringify(raw), splitSegments(f.material.segments)[0]!, { ...f.plan, allowModelSupplement: false }), /不允许无来源补充/);
});
withFixture("大课超过模型调用预算时提前拒绝，没有静默少读一段", async f => {
  const calls: string[] = [];
  const big = materialWith(Array.from({ length: 120 }, (_, i) => ({ start: i, end: i + 1, text: "x".repeat(980) })));
  await assert.rejects(new LearnService(f.store).generate(f.plan, big, fakeModel(calls)), /超过 12 次/);
  assert.equal(calls.length, 0);
});
withFixture("取消过程中不生成半份草稿或成品", async f => {
  const controller = new AbortController();
  await assert.rejects(new LearnService(f.store).fromMaterial(f.material.id, async () => { controller.abort(); return { text: "{}" }; }, controller.signal));
  assert.equal((await f.store.list("drafts")).length, 0);
  assert.deepEqual(await fs.readdir(f.outputDir), []);
});
withFixture("并发处理相同材料不重复提交模型", async f => {
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const service = new LearnService(f.store), run = fakeModel();
  const first = service.fromMaterial(f.material.id, async request => { started(); await wait; return run(request); });
  await ready;
  await assert.rejects(service.fromMaterial(f.material.id, run), /相同任务正在执行/);
  release(); await first;
});
withFixture("计划 ID 不能变成路径，未选择的目录不作为输出", async f => {
  assert.throws(() => validatePlan({ ...f.plan, id: "../escape" }), /ID 只能/);
  assert.throws(() => validatePlan({ ...f.plan, outputDir: "relative" }), /绝对路径/);
  assert.throws(() => validatePlan({ ...f.plan, topic: "" }), /学习主题/);
  assert.equal(path.isAbsolute((await f.store.activePlan()).outputDir), true);
});
