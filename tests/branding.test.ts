import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultHome } from "../src/files.ts";
import { renderMarkdown } from "../src/notes.ts";
import { fixture } from "./helpers.ts";

test("Nibblearn 包名与锁文件一致，当前仍仅声明 pi 适配器", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "nibblearn");
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[""].name, manifest.name);
  assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
});

test("NIBBLEARN_HOME 优先，旧环境变量与原默认目录继续兼容", () => {
  const names = ["NIBBLEARN_HOME", "PI_LEARN_HOME", "PI_CODING_AGENT_DIR"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const base = path.join(os.tmpdir(), "nibblearn-home-compatibility");
  try {
    process.env.NIBBLEARN_HOME = path.join(base, "current");
    process.env.PI_LEARN_HOME = path.join(base, "legacy");
    process.env.PI_CODING_AGENT_DIR = path.join(base, "pi-agent");
    assert.equal(defaultHome(), process.env.NIBBLEARN_HOME);
    delete process.env.NIBBLEARN_HOME;
    assert.equal(defaultHome(), process.env.PI_LEARN_HOME);
    delete process.env.PI_LEARN_HOME;
    assert.equal(defaultHome(), path.join(base, "pi-agent", "video-learn"));
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("新笔记使用 Nibblearn 品牌，不改变旧文件或数据位置", async () => {
  const f = await fixture();
  try {
    const markdown = renderMarkdown(f.plan, f.material, [{ overview: "概述", points: [], supplements: [], questions: [], caveats: [] }], "branding-demo");
    assert.match(markdown, /由 Nibblearn 辅助整理/);
    assert.deepEqual(await fs.readdir(f.outputDir), []);
  } finally { await f.cleanup(); }
});
