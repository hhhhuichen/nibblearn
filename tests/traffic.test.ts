import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createTrafficGuard, RISK_DEFAULTS } from "../vendor/dsh-bili-whale/traffic.mjs";
import { fixture, json } from "./helpers.ts";

const URL = "https://api.bilibili.com/x/web-interface/nav";
const headers = { cookie: "SESSDATA=DUMMY" };

test("继承的跨进程预算与零写预算生效", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const directory = await f.store.directory("traffic");
    const options = { directory, settings: () => ({ ...RISK_DEFAULTS, minGapMs: 0, readHourly: 1 }), transport: (async () => { calls++; return json({ code: 0 }); }) as typeof fetch };
    await createTrafficGuard(options).fetch(URL, { headers });
    await assert.rejects(createTrafficGuard(options).fetch(URL, { headers }), /读取预算/);
    await assert.rejects(createTrafficGuard(options).fetch(URL, { headers, method: "POST", body: "message=test" }), /写操作预算/);
    assert.equal(calls, 1);
    assert.equal((await fs.readFile(path.join(directory, "traffic-state.json"), "utf8")).includes("DUMMY"), false);
  } finally { await f.cleanup(); }
});
test("429与Retry-After触发暂停，resume不清除平台要求的等待", async () => {
  const f = await fixture();
  try {
    const guard = createTrafficGuard({ directory: await f.store.directory("traffic"), settings: () => ({ ...RISK_DEFAULTS, minGapMs: 0 }),
      transport: (async () => json({ code: -412 }, 429, { "retry-after": "900" })) as typeof fetch });
    await guard.fetch(URL, { headers });
    const state = guard.status(); assert.ok(Number(state.until) > Date.now() + 890_000);
    await guard.resume(headers);
    await assert.rejects(guard.fetch(URL, { headers }), /请求已暂停/);
  } finally { await f.cleanup(); }
});
test("损坏的限流状态 fail closed，而不是重置后继续请求", async () => {
  const f = await fixture();
  try {
    const directory = await f.store.directory("traffic");
    await fs.writeFile(path.join(directory, "traffic-state.json"), "not JSON");
    let calls = 0;
    const guard = createTrafficGuard({ directory, transport: (async () => { calls++; return json({ code: 0 }); }) as typeof fetch });
    await assert.rejects(guard.fetch(URL, { headers }), /状态损坏/); assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});
