import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLearnExtension } from "../extensions/index.ts";
import { renderMarkdown } from "../src/notes.ts";
import { createReadingDraft, readingMarkdown } from "../src/reading.ts";
import { Store } from "../src/store.ts";
import { LearnError } from "../src/types.ts";
import type { CourseDraft, Material, MaterialDraft, Plan, PracticeDraft } from "../src/types.ts";
import { emptyUsage } from "../src/usage.ts";
import { hash } from "../src/validate.ts";

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nibblearn-reading-test-"));
  const store = new Store(home);
  const plan: Plan = { schemaVersion: 1, id: "plan-test", revision: 1, title: "学习", topic: "机器学习", goal: "理解算法", background: "", focus: "",
    noteStyle: "markdown", language: "zh-CN", outputDir: path.join(home, "output"), allowModelSupplement: true, consentModelTransfer: false, references: [] };
  await store.write("plans", plan.id, plan); await store.selectPlan(plan.id);
  const material: Material = { schemaVersion: 1, id: "material-test", kind: "bilibili-subtitle", title: "线性模型", author: "作者", language: "zh-CN",
    sourceUrl: "https://www.bilibili.com/video/BV13bZYBREgr/?p=1", warnings: [], fetchedAt: "2026-01-01T00:00:00.000Z", segments: [{ start: 1, end: 3, text: "独立证据原文" }] };
  const draft: MaterialDraft = { schemaVersion: 1, id: "source-draft", planId: plan.id, planRevision: 1, title: material.title, materialId: material.id,
    markdown: renderMarkdown(plan, material, [{ overview: "导读", points: [{ heading: "训练", explanation: "正文必须保留。\n\n$$\nL=(x-y)^2\n$$\n\n`[E1](#e1)` 是代码示例。\n\n```markdown\n## 来源说明\n来源：[E1](#e1)\n```", evidence: [0] }], supplements: [{ text: "必要的补充，未核验", referenceIds: [] }], questions: [], caveats: ["数据仍有缺口"] }], "source-draft"),
    usage: { ...emptyUsage(), totalTokens: 100 }, createdAt: material.fetchedAt, publishedPaths: [] };
  await store.updateDraft(draft);
  return { home, store, plan, draft, close: () => fs.rm(home, { recursive: true, force: true }) };
}

function tutorial(source: MaterialDraft): CourseDraft {
  return { ...source, kind: "course", title: "综合教程", course: { jobId: "course-test", bvid: "BV13bZYBREgr", total: 1, parts: [], tutorial: true },
    markdown: `---\ntitle: "综合教程"\ndraft_id: "source-draft"\nsource_kind: "course-tutorial"\n---\n\n# 综合教程\n\n- 正文仅保留简短来源定位，完整原稿和材料仍在本机缓存。\n\n## 第1章 训练\n\n算法正文。\n\n来源：[1·字幕讲义][u1]、[2·采样画面旧描述][u2]、[3·模型补充（非视频原话）][u3]、[4·材料疑点][u4]（含旧稿采样画面描述，无声音；含非视频原话的补充，未独立核验）\n\n## 材料缺口与待核对\n\n- 未完整观看，没有声音；原稿不是已核验事实。\n\n## 取舍说明\n\n- 合并重复解释。\n\n## 来源说明\n\n### 来源 1：原视频\n\n#### U1\n\n**字幕**\n\n#### U2\n\n**采样画面**\n\n#### U3\n\n**补充**\n\n#### U4\n\n**疑点**\n\n## 个人补注\n\n这段自定义内容要保留。\n\n[u1]: #u1\n[u2]: #u2\n[u3]: #u3\n[u4]: #u4\n` };
}

test("material reading edition preserves body, math, literal code and uncertainty", async () => {
  const f = await fixture();
  try {
    const text = readingMarkdown(f.draft, "reading-draft");
    assert.ok(!text.includes("## 字幕来源索引"));
    assert.ok(!text.includes("独立证据原文"));
    assert.ok(!text.includes("\n来源：[E1](#e1)\n\n"));
    assert.ok(text.includes("```markdown\n## 来源说明\n来源：[E1](#e1)\n```"));
    assert.ok(text.includes("`[E1](#e1)` 是代码示例。"));
    assert.ok(text.includes("$$\nL=(x-y)^2\n$$"));
    assert.ok(text.includes("数据仍有缺口")); assert.ok(text.includes("必要的补充，未核验"));
    assert.ok(text.includes('draft_id: "reading-draft"')); assert.ok(text.includes('source_draft_id: "source-draft"'));
    assert.ok(text.includes("无索引阅读版"));
  } finally { await f.close(); }
});

for (const [label, bom, newline] of [["UTF-8 BOM", true, "\n"], ["CRLF", false, "\r\n"], ["UTF-8 BOM and CRLF", true, "\r\n"]] as const) {
  test(`reading conversion accepts ${label} without duplicating source metadata`, async () => {
    const f = await fixture();
    try {
      const source = { ...f.draft, markdown: (bom ? "\uFEFF" : "") + f.draft.markdown.replace(/\n/g, newline) };
      const text = readingMarkdown(source, "reading-draft");
      assert.ok(text.startsWith("---\n")); assert.ok(!text.includes("\r")); assert.ok(!text.includes("\uFEFF"));
      assert.equal((text.match(/^draft_id:/gm) ?? []).length, 1);
      assert.ok(text.includes('draft_id: "reading-draft"'));
      assert.ok(text.includes(`source_snapshot_sha256: "${hash(source.markdown)}"`));
      assert.ok(text.includes("$$\nL=(x-y)^2\n$$"));
      assert.ok(!text.includes("## 字幕来源索引"));
    } finally { await f.close(); }
  });
}

test("tilde-fenced citation examples and ordinary links remain literal", async () => {
  const f = await fixture();
  try {
    const sample = "~~~~markdown\n## 字幕来源索引\n来源：[E1](#e1)\n```\n~~~~";
    const links = "[使用说明](https://example.org/guide) 与 [训练章节](#训练)";
    const source = { ...f.draft, markdown: f.draft.markdown.replace("正文必须保留。", `正文必须保留。\n\n${sample}\n\n${links}`) };
    const text = readingMarkdown(source, "reading-draft");
    assert.ok(text.includes(sample)); assert.ok(text.includes(links));
    assert.ok(!text.includes("独立证据原文"));
  } finally { await f.close(); }
});

test("custom multiline metadata is refused rather than being partially rewritten", async () => {
  const f = await fixture();
  try {
    const source = { ...f.draft, markdown: f.draft.markdown.replace('title: "线性模型"', "title: >\n  自定义多行标题") };
    assert.throws(() => readingMarkdown(source, "reading-draft"), e => e instanceof LearnError && e.code === "READING_FORMAT_UNSUPPORTED");
  } finally { await f.close(); }
});

test("tutorial drops numbered links but preserves visual, supplement and caveat identities", async () => {
  const f = await fixture();
  try {
    const text = readingMarkdown(tutorial(f.draft), "reading-draft");
    assert.ok(!text.includes("\n## 来源说明\n")); assert.ok(!text.includes("#### U1")); assert.ok(!text.includes("[u1]"));
    assert.ok(text.includes("算法正文。")); assert.ok(text.includes("## 个人补注\n\n这段自定义内容要保留。"));
    assert.ok(text.includes("本节依据旧稿采样画面描述，无声音，不代表连续观看"));
    assert.ok(text.includes("含非视频原话的补充或参考，未独立核验"));
    assert.ok(text.includes("涉及材料疑点")); assert.ok(text.includes("材料缺口与待核对"));
    assert.ok(text.includes("合并重复解释")); assert.ok(!text.includes("正文仅保留简短来源定位"));
  } finally { await f.close(); }
});

for (const namespace of ["P1", "V2-P3"]) {
  test(`merged-course namespace ${namespace} is removed without changing the course contents`, async () => {
    const f = await fixture();
    try {
      const source = tutorial(f.draft);
      source.markdown = `# 合并讲义\n\n## ${namespace}\n\n正文。\n\n来源：[E1](#${namespace.toLowerCase()}-e1)\n\n## 材料范围与限制\n\n仅采样，无声音。\n\n## 来源索引\n\n### 来源\n\n#### ${namespace}-E1\n\n索引原文\n\n## 编排说明\n\n本机编排，不代表完整观看。\n`;
      const text = readingMarkdown(source, "reading-draft");
      assert.ok(text.includes(`## ${namespace}`)); assert.ok(text.includes("正文。"));
      assert.ok(text.includes("仅采样，无声音。")); assert.ok(text.includes("本机编排，不代表完整观看。"));
      assert.ok(!text.includes("来源：[E1]")); assert.ok(!text.includes("索引原文"));
    } finally { await f.close(); }
  });
}

test("ambiguous custom references fail closed instead of producing dangling links", async () => {
  const f = await fixture();
  try {
    const source = tutorial(f.draft);
    source.markdown = source.markdown.replace("算法正文。", "算法正文：参见[自定义引用](#u1)。");
    assert.throws(() => readingMarkdown(source, "reading-draft"), e => e instanceof LearnError && e.code === "READING_FORMAT_UNSUPPORTED");
    source.markdown = tutorial(f.draft).markdown.replace("（含旧稿采样画面描述，无声音；含非视频原话的补充，未独立核验）", "；自定义重要补注");
    assert.throws(() => readingMarkdown(source, "reading-draft"), e => e instanceof LearnError && e.code === "READING_FORMAT_UNSUPPORTED");
  } finally { await f.close(); }
});

test("unrecognized indexes and unclosed fences are not blindly deleted", async () => {
  const f = await fixture();
  try {
    const source = { ...f.draft, markdown: "# 标题\n\n## 来源说明\n\n不是标准来源索引的自定义内容。" };
    assert.throws(() => readingMarkdown(source, "reading-draft"), /无法识别来源索引/);
    source.markdown = f.draft.markdown + "\n```python\nprint('unfinished')";
    assert.throws(() => readingMarkdown(source, "reading-draft"), /未闭合代码块/);
    source.markdown = "# 自定义正文\n\n没有索引。";
    assert.throws(() => readingMarkdown(source, "reading-draft"), e => e instanceof LearnError && e.code === "READING_NO_INDEX");
  } finally { await f.close(); }
});

test("local conversion is zero-usage, separately reviewable and keeps unfinished edits", async () => {
  const f = await fixture();
  try {
    const before = await fs.readFile(path.join(f.home, "drafts", f.draft.id + ".json"), "utf8");
    const reading = await createReadingDraft(f.store, f.draft.id, hash(f.draft.markdown));
    assert.notEqual(reading.id, f.draft.id); assert.ok(reading.readingVersion);
    assert.equal(reading.usage.totalTokens, 0); assert.deepEqual(reading.publishedPaths, []);
    assert.equal(await fs.readFile(path.join(f.home, "drafts", f.draft.id + ".json"), "utf8"), before);
    await assert.rejects(fs.access(f.plan.outputDir));
    await f.store.updateDraft({ ...reading, markdown: reading.markdown + "\n用户尚未发布的编辑。" });
    const reused = await createReadingDraft(f.store, f.draft.id, hash(f.draft.markdown));
    assert.equal(reused.id, reading.id); assert.ok(reused.markdown.endsWith("用户尚未发布的编辑。"));
    assert.equal((await createReadingDraft(f.store, reused.id, hash(reused.markdown))).id, reused.id);
    await f.store.updateDraft({ ...f.draft, markdown: f.draft.markdown + "\n新的原稿补注。" });
    await assert.rejects(createReadingDraft(f.store, f.draft.id, hash(f.draft.markdown)), e => e instanceof LearnError && e.code === "REVIEW_CONFLICT");
    const updated = await f.store.draft(f.draft.id);
    const next = await createReadingDraft(f.store, updated.id, hash(updated.markdown));
    assert.notEqual(next.id, reading.id); assert.ok(next.markdown.includes("新的原稿补注。"));
    assert.ok((await f.store.draft(reading.id)).markdown.includes("用户尚未发布的编辑。"));
  } finally { await f.close(); }
});

test("plan mismatch and practice input do not create presentation drafts", async () => {
  const f = await fixture();
  try {
    await f.store.write("plans", f.plan.id, { ...f.plan, revision: 2 });
    await assert.rejects(createReadingDraft(f.store, f.draft.id, hash(f.draft.markdown)), e => e instanceof LearnError && e.code === "PLAN_CHANGED");
    const practice: PracticeDraft = { ...f.draft, kind: "practice", practice: { jobId: "practice-test", sourceDraftId: "source-draft", sourceHash: "hash", mode: "both" } };
    assert.throws(() => readingMarkdown(practice, "reading-draft"), e => e instanceof LearnError && e.code === "READING_UNSUPPORTED");
    assert.equal((await f.store.list("drafts")).length, 1);
  } finally { await f.close(); }
});

for (const edition of ["indexed", "reading", "cancel"]) {
  test(`review UI ${edition}: default is indexed, conversion never publishes or calls a model`, async () => {
    const f = await fixture();
    try {
      let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined, selections = 0, modelCalls = 0, transportCalls = 0;
      const reports: string[] = [];
      const pi = { on() {}, registerTool() {}, sendMessage(message: { content: string }) { reports.push(message.content); },
        registerCommand(name: string, command: { handler: typeof handler }) { if (name === "learn") handler = command.handler; } };
      createLearnExtension({ home: f.home, transport: (async () => { transportCalls++; throw new Error("network forbidden"); }) as typeof fetch })(pi as unknown as Parameters<ReturnType<typeof createLearnExtension>>[0]);
      assert.ok(handler);
      const ctx = { hasUI: true, signal: new AbortController().signal,
        modelRegistry: { streamSimple() { modelCalls++; throw new Error("model forbidden"); } },
        ui: { notify(message: string) { throw new Error(message); }, confirm() { throw new Error("publication was not requested"); },
          async select(_title: string, choices: string[]) {
            selections++;
            if (selections === 1) { assert.match(choices[0]!, /带来源索引（默认/); return edition === "cancel" ? undefined : choices[edition === "reading" ? 1 : 0]; }
            if (selections === 2) return choices.find(c => c.startsWith("只显示审核文件路径"));
            return choices.find(c => c.startsWith("暂不导入"));
          } } };
      await handler("review " + f.draft.id, ctx);
      const drafts = await f.store.list<MaterialDraft>("drafts");
      assert.equal(drafts.length, edition === "reading" ? 2 : 1);
      assert.equal(modelCalls, 0); assert.equal(transportCalls, 0);
      assert.equal((await f.store.draft(f.draft.id)).markdown, f.draft.markdown);
      assert.ok(drafts.every(d => d.publishedPaths.length === 0));
      await assert.rejects(fs.access(f.plan.outputDir));
      if (edition !== "cancel") assert.ok(reports.some(message => message.includes("尚未发布")));
    } finally { await f.close(); }
  });
}
