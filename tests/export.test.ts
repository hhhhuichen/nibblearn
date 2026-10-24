import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditContent, exportSources, ROOT_FILES, SOURCE_DIRECTORIES } from "../scripts/export-source.mjs";

async function sourceFixture() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nibblearn-export-"));
  const source = path.join(temporary, "source"), destination = path.join(temporary, "upload");
  await fs.mkdir(source);
  for (const file of ROOT_FILES) await fs.writeFile(path.join(source, file), file.endsWith(".json") ? "{}" : "Example source\n");
  for (const directory of SOURCE_DIRECTORIES) await fs.mkdir(path.join(source, directory), { recursive: true });
  await fs.writeFile(path.join(source, "src", "index.ts"), "export const example = true;\n");
  await fs.writeFile(path.join(source, "examples", "credentials.example.json"), '{"sessdata":"","bili_jct":"","buvid3":""}');
  return { temporary, source, destination, cleanup: () => fs.rm(temporary, { recursive: true, force: true }) };
}
test("源码导出采用白名单，不包含依赖、Git历史、凭据或运行数据", async () => {
  const f = await sourceFixture();
  try {
    for (const directory of ["node_modules", ".git", "secrets", "drafts"]) {
      await fs.mkdir(path.join(f.source, directory));
      await fs.writeFile(path.join(f.source, directory, "private.txt"), "SHOULD_NOT_EXPORT");
    }
    await fs.writeFile(path.join(f.source, ".env"), "PRIVATE_TOKEN=secret");
    await fs.writeFile(path.join(f.source, "examples", "credentials.json"), '{"sessdata":"DO_NOT_EXPORT"}');
    const result = await exportSources(f.source, f.destination);
    assert.equal(result.files, ROOT_FILES.length + 2);
    assert.equal(await fs.readFile(path.join(f.destination, "src", "index.ts"), "utf8"), "export const example = true;\n");
    for (const item of ["node_modules", ".git", "secrets", "drafts", ".env", "examples/credentials.json"]) await assert.rejects(fs.access(path.join(f.destination, item)), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});
test("导出拒绝覆盖现有目录及源目录重叠", async () => {
  const f = await sourceFixture();
  try {
    await fs.mkdir(f.destination);
    await fs.writeFile(path.join(f.destination, "keep.txt"), "manual");
    await assert.rejects(exportSources(f.source, f.destination), /already exists/);
    assert.equal(await fs.readFile(path.join(f.destination, "keep.txt"), "utf8"), "manual");
    await assert.rejects(exportSources(f.source, path.join(f.source, "output")), /overlap/);
    await assert.rejects(exportSources(f.source, f.temporary), /overlap/);
  } finally { await f.cleanup(); }
});
test("检测非空凭据示例、真实令牌形态与个人主目录路径", () => {
  assert.throws(() => auditContent("examples/credentials.example.json", Buffer.from('{"sessdata":"unexpected-secret","bili_jct":"","buvid3":""}')), /credential/);
  assert.throws(() => auditContent("src/bad.ts", Buffer.from("const value = 'ghp_" + "a".repeat(30) + "';")), /credential-like/);
  assert.throws(() => auditContent("README.md", Buffer.from(os.homedir())), /machine-specific/);
  assert.throws(() => auditContent("README.md", Buffer.from(os.homedir().replace(/\\/g, "/"))), /machine-specific/);
});
test("依赖锁文件中的私有地址或认证信息阻止导出", () => {
  const lock = (resolved: string) => Buffer.from(JSON.stringify({ packages: { demo: { resolved } } }));
  assert.doesNotThrow(() => auditContent("package-lock.json", lock("https://registry.npmjs.org/example/-/example-1.0.0.tgz")));
  assert.throws(() => auditContent("package-lock.json", lock("https://token@registry.npmjs.org/example.tgz")), /dependency URL/);
  assert.throws(() => auditContent("package-lock.json", lock("file:../private-package")), /dependency URL|dependency location/);
});
