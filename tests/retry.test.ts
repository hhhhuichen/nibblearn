import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, fakeModel, usage } from "./helpers.ts";
import { LearnService } from "../src/service.ts";
import { renderMarkdown } from "../src/notes.ts";
import { ModelRunError, publicError } from "../src/types.ts";

test("失败任务不被模型自动重试；人工许可后可重试并保留历史用量", async () => {
  const f = await fixture();
  try {
    const service = new LearnService(f.store);
    await assert.rejects(service.fromMaterial(f.material.id, async () => ({ text: "not JSON", usage })), /人工运行/);
    const jobs = await f.store.list<{ id: string; status: string; history: unknown[] }>("jobs");
    const jobId = jobs[0]!.id;
    const calls: string[] = [];
    await assert.rejects(service.fromMaterial(f.material.id, fakeModel(calls)), /不会自动再次消耗/);
    assert.equal(calls.length, 0);
    assert.equal(await service.approveRetry(jobId), f.material.id);
    const result = await service.fromMaterial(f.material.id, fakeModel(calls));
    assert.equal(calls.length, 1); assert.equal(result.reused, false);
    const completed = await f.store.read<{ history: { usage: { totalTokens: number } }[] }>("jobs", jobId);
    assert.equal(completed!.history[0]!.usage.totalTokens, 150);
  } finally { await f.cleanup(); }
});
test("模型生成的外部图片与HTML不成为自动加载内容", async () => {
  const f = await fixture();
  try {
    const note = renderMarkdown(f.plan, f.material, [{ overview: "![external][pixel]\n[pixel]: https://example.test/pixel\n<img src=x>", points: [], supplements: [], questions: [], caveats: [] }], "demo");
    assert.match(note, /\\!\[external\]/);
    assert.equal(note.includes("<img"), false);
    assert.match(note, /&lt;img/);
  } finally { await f.cleanup(); }
});
test("底层错误不泄漏请求详情，文件错误给出可操作提示", () => {
  assert.equal(publicError(new Error("Authorization: SECRET" )).includes("SECRET"), false);
  assert.match(publicError(Object.assign(new Error("secret path"), { code: "ENOENT" })), /找不到指定文件/);
});
test("模型到达输出上限时仍记录服务已返回的用量", async () => {
  const f = await fixture();
  try {
    await assert.rejects(new LearnService(f.store).fromMaterial(f.material.id, async () => {
      throw new ModelRunError("MODEL_INCOMPLETE", "输出达到上限", usage);
    }), /输出达到上限/);
    const jobs = await f.store.list<{ usage: { totalTokens: number } }>("jobs");
    assert.equal(jobs[0]!.usage.totalTokens, 150);
    assert.equal((await f.store.list("drafts")).length, 0);
  } finally { await f.cleanup(); }
});
