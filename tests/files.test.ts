import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.ts";
import { ensureDirectory, publishMarkdown, safeFilename } from "../src/files.ts";

test("文件名清理路径穿越和 Windows 保留名", () => {
  assert.equal(safeFilename("CON"), "note");
  assert.equal(safeFilename("NUL.txt"), "note");
  assert.equal(/[\\/:*?"<>|]/.test(safeFilename('../../evil:<note>')), false);
});
test("符号链接/目录联接不能逃出授权输出根目录", async () => {
  const f = await fixture();
  try {
    const outside = await ensureDirectory(path.join(f.root, "outside"));
    await fs.symlink(outside, path.join(f.outputDir, f.plan.id), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(publishMarkdown(f.outputDir, f.plan.id, "课程", "a".repeat(64), "hello"), /链接/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await f.cleanup(); }
});
test("已有同名文件即使是链接也不跟随或覆盖", async () => {
  const f = await fixture();
  try {
    const one = await publishMarkdown(f.outputDir, f.plan.id, "课程", "a".repeat(64), "first");
    await fs.writeFile(one, "manual");
    const two = await publishMarkdown(f.outputDir, f.plan.id, "课程", "a".repeat(64), "second");
    assert.notEqual(one, two);
    assert.equal(await fs.readFile(one, "utf8"), "manual");
    assert.equal(await fs.readFile(two, "utf8"), "second");
    assert.equal((await fs.readdir(path.dirname(one))).some(n => n.endsWith(".tmp")), false);
  } finally { await f.cleanup(); }
});
test("授权根目录被替换后停止保存", async () => {
  const f = await fixture();
  try {
    const outside = await ensureDirectory(path.join(f.root, "outside"));
    await fs.rmdir(f.outputDir);
    await fs.symlink(outside, f.outputDir, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(publishMarkdown(f.outputDir, f.plan.id, "课程", "a".repeat(64), "hello"), /链接/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await f.cleanup(); }
});
test("状态目录的子目录链接也不能被用于读写凭据", async () => {
  const f = await fixture();
  try {
    const outside = await ensureDirectory(path.join(f.root, "outside"));
    await fs.symlink(outside, path.join(f.home, "secrets"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(f.store.saveCredentials({ sessdata: "not-a-real-secret" }), /链接/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await f.cleanup(); }
});
