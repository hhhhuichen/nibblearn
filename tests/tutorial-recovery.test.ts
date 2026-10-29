import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderMarkdown } from "../src/notes.ts";
import { Store } from "../src/store.ts";
import { synthesizeCourse } from "../src/tutorial.ts";
import { ModelRunError } from "../src/types.ts";
import type { CourseJob, MaterialDraft, ModelRunner, Plan } from "../src/types.ts";
import { emptyUsage } from "../src/usage.ts";

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nibblearn-test-"));
  const store = new Store(home);
  const plan: Plan = { schemaVersion: 1, id: "plan-test", revision: 1, title: "测试", topic: "机器学习", goal: "理解算法",
    background: "", focus: "", noteStyle: "markdown", language: "zh-CN", outputDir: path.join(home, "output"), allowModelSupplement: false, consentModelTransfer: true, references: [] };
  await store.write("plans", plan.id, plan);
  await store.selectPlan(plan.id);
  const material = await store.saveMaterial({ schemaVersion: 1, kind: "bilibili-subtitle", title: "测试材料", author: "测试作者", bvid: "BV13bZYBREgr", cid: 1, part: 1,
    sourceUrl: "https://www.bilibili.com/video/BV13bZYBREgr/?p=1", language: "zh-CN", warnings: [], fetchedAt: "2026-01-01T00:00:00.000Z",
    segments: [{ start: 0, end: 1, text: "规则一" }, { start: 1, end: 2, text: "规则二" }] });
  const draft: MaterialDraft = { schemaVersion: 1, id: "source-draft", planId: plan.id, planRevision: 1, title: material.title, materialId: material.id,
    markdown: renderMarkdown(plan, material, [{ overview: "导读", points: [{ heading: "第一规则", explanation: "解释一", evidence: [0] }, { heading: "第二规则", explanation: "解释二", evidence: [1] }], supplements: [], questions: [], caveats: [] }], "source-draft"),
    createdAt: "2026-01-01T00:00:00.000Z", usage: emptyUsage(), publishedPaths: [] };
  await store.updateDraft(draft);
  const course: CourseJob = { id: "course-test", kind: "course", planId: plan.id, planRevision: 1, title: "测试课程", bvid: material.bvid!, total: 1, status: "completed",
    completed: [{ part: 1, bvid: material.bvid, sourcePart: 1, cid: 1, title: material.title, draftId: draft.id, visual: false, reused: false }], at: draft.createdAt };
  await store.write("jobs", course.id, course);
  return { store, course, home, close: () => fs.rm(home, { recursive: true, force: true }) };
}

const usage = () => ({ ...emptyUsage(), input: 2, output: 1, totalTokens: 3 });
function outline(ids: string[]) {
  return { title: "测试教程", introduction: "学习路线", chapters: [
    { heading: "第一章", objective: "学习规则一", sourceIds: ids.slice(0, 1) },
    { heading: "第二章", objective: "学习规则二", sourceIds: ids.slice(1) },
  ], omitted: [], caveats: [] };
}
function chapter(ids: string[]) {
  return { introduction: "章节导读", sections: [{ heading: "方法", body: "完整教学正文与适用条件。", sourceIds: ids }], caveats: [], unused: [], teachingMemory: { concepts: ["已解释方法"], conventions: [] } };
}

test("duplicate valid citations are deduplicated without paying for a repair call", async () => {
  const f = await fixture(); let calls = 0;
  try {
    const run: ModelRunner = async request => {
      calls++; const p = JSON.parse(request.prompt);
      if (p.catalog) {
        const o = outline(p.catalog.map((x: { id: string }) => x.id));
        o.chapters[0]!.sourceIds.push(o.chapters[0]!.sourceIds[0]!);
        return { text: JSON.stringify(o), usage: usage() };
      }
      assert.ok(p.writingBudget.allowedSourceIds.length);
      return { text: JSON.stringify(chapter([...p.chapter.sourceIds, p.chapter.sourceIds[0]])), usage: usage() };
    };
    const result = await synthesizeCourse(f.store, f.course.id, run, async () => true);
    assert.equal(result.status, "draft"); assert.equal(calls, 3);
    const job = await f.store.read<any>("jobs", result.jobId);
    assert.equal(job.outline.chapters[0].sourceIds.length, 1);
    for (const c of job.chapters) assert.equal(c.sections[0].sourceIds.length, new Set(c.sections[0].sourceIds).size);
    assert.equal(job.usage.totalTokens, 9);
    assert.deepEqual((await f.store.draft(result.draftId!)).publishedPaths, []);
    await assert.rejects(fs.access(path.join(f.home, "output")));
  } finally { await f.close(); }
});

for (const [label, ids] of [["empty", []], ["unknown", ["U999"]], ["untrusted text", ["private-provider-secret"]]] as const) {
  test(`rejects ${label} source list with a field-specific safe diagnostic`, async () => {
    const f = await fixture(); let calls = 0;
    try {
      const result = await synthesizeCourse(f.store, f.course.id, async request => {
        calls++; const p = JSON.parse(request.prompt), o = outline(p.catalog.map((x: { id: string }) => x.id));
        o.chapters[0]!.sourceIds = [...ids];
        return { text: JSON.stringify(o), usage: usage() };
      }, async () => true);
      assert.equal(result.status, "stopped"); assert.equal(calls, 1);
      assert.equal(result.failure?.stage, "outline");
      assert.equal(result.failure?.code, "INVALID_TUTORIAL_EVIDENCE");
      assert.match(result.error!, /chapters\[0\]\.sourceIds/);
      assert.ok(!JSON.stringify(result).includes("private-provider-secret"));
      assert.equal((await f.store.list("drafts")).length, 1);
    } finally { await f.close(); }
  });
}

for (const violation of ["cross-chapter allocation", "unaccounted source"]) {
  test(`planning still rejects ${violation} without silently dropping evidence`, async () => {
    const f = await fixture(); let calls = 0;
    try {
      const result = await synthesizeCourse(f.store, f.course.id, async request => {
        calls++; const p = JSON.parse(request.prompt), o = outline(p.catalog.map((x: { id: string }) => x.id));
        if (violation === "cross-chapter allocation") o.chapters[1]!.sourceIds.push(o.chapters[0]!.sourceIds[0]!);
        else o.chapters[1]!.sourceIds.pop();
        return { text: JSON.stringify(o), usage: usage() };
      }, async () => true);
      assert.equal(result.status, "stopped"); assert.equal(calls, 1);
      assert.equal(result.failure?.code, "INVALID_TUTORIAL_PLAN");
      assert.equal((await f.store.list("drafts")).length, 1);
    } finally { await f.close(); }
  });
}

test("source assigned to another chapter is still rejected; retry resumes only after approval", async () => {
  const f = await fixture(); let calls = 0, firstId = "";
  try {
    const run: ModelRunner = async request => {
      calls++; const p = JSON.parse(request.prompt);
      if (p.catalog) { const ids = p.catalog.map((x: { id: string }) => x.id); firstId = ids[0]; return { text: JSON.stringify(outline(ids)), usage: usage() }; }
      return { text: JSON.stringify(chapter(calls === 3 ? [firstId] : p.chapter.sourceIds)), usage: usage() };
    };
    const failed = await synthesizeCourse(f.store, f.course.id, run, async () => true);
    assert.equal(failed.status, "stopped"); assert.equal(calls, 3);
    assert.equal(failed.failure?.chapter, 2); assert.equal(failed.failure?.completedChapters, 1);
    assert.match(failed.error!, /sections\[0\]\.sourceIds/);
    const denied = async () => { throw new Error("model must not run without approval"); };
    await assert.rejects(synthesizeCourse(f.store, failed.jobId, denied, async () => false), /已取消综合/);
    let resumedCalls = 0; const approvals: string[] = [];
    const resumed = await synthesizeCourse(f.store, failed.jobId, async request => {
      resumedCalls++; const p = JSON.parse(request.prompt); assert.ok(!p.catalog);
      return { text: JSON.stringify(chapter(p.chapter.sourceIds)), usage: usage() };
    }, async summary => { approvals.push(summary.stage); return true; });
    assert.equal(resumed.status, "draft"); assert.equal(resumedCalls, 1);
    assert.deepEqual(approvals, ["budget", "outline"]);
    const job = await f.store.read<any>("jobs", failed.jobId);
    assert.equal(job.chapters.length, 2); assert.equal(job.failures.length, 1);
    assert.equal(job.failures[0].chapter, 2); assert.equal(job.error, undefined);
    assert.equal(job.usage.totalTokens, 12);
  } finally { await f.close(); }
});

test("output-limit diagnostic and known failure usage persist across successful continuation", async () => {
  const f = await fixture(); let calls = 0;
  try {
    const diagnostics = { stopReason: "length" as const, maxTokens: 4096, modelMaxTokens: 8192, contextWindow: 131072, estimatedInputTokens: 20000 };
    const failed = await synthesizeCourse(f.store, f.course.id, async request => {
      calls++; const p = JSON.parse(request.prompt);
      if (p.catalog) return { text: JSON.stringify(outline(p.catalog.map((x: { id: string }) => x.id))), usage: usage() };
      throw new ModelRunError("MODEL_OUTPUT_LIMIT", "模型输出达到上限", usage(), diagnostics);
    }, async () => true);
    assert.equal(failed.status, "stopped"); assert.equal(calls, 2);
    assert.equal(failed.failure?.stage, "chapter"); assert.equal(failed.failure?.chapter, 1);
    assert.deepEqual(failed.failure?.diagnostics, diagnostics);
    assert.equal(failed.usage.totalTokens, 6);
    let resumeCalls = 0;
    const result = await synthesizeCourse(f.store, failed.jobId, async request => {
      resumeCalls++; const p = JSON.parse(request.prompt);
      assert.equal(p.writingBudget.previousOutputLimitTokens, resumeCalls === 1 ? 4096 : undefined);
      return { text: JSON.stringify(chapter(p.chapter.sourceIds)), usage: usage() };
    }, async () => true);
    assert.equal(result.status, "draft"); assert.equal(resumeCalls, 2);
    const job = await f.store.read<any>("jobs", result.jobId);
    assert.equal(job.failures.length, 1); assert.deepEqual(job.failures[0].diagnostics, diagnostics);
    assert.equal(job.usage.totalTokens, 12);
    let cachedCalls = 0;
    const cached = await synthesizeCourse(f.store, f.course.id, async () => { cachedCalls++; throw new Error("no call"); }, async () => { throw new Error("no confirmation needed for reuse"); });
    assert.equal(cached.reused, true); assert.equal(cachedCalls, 0);
  } finally { await f.close(); }
});
