import { test } from "node:test";
import assert from "node:assert/strict";
import { BilibiliProvider, parseVideo, subtitleUrl } from "../src/bilibili.ts";
import { fixture, json } from "./helpers.ts";

const BV = "BV1GJ411x7h7";
const IMAGES = { img_url: `https://i0.hdslb.com/bfs/wbi/${"a".repeat(32)}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${"b".repeat(32)}.png` };

test("视频输入严格限制域名与分P，去掉跟踪参数", () => {
  assert.equal(parseVideo(BV).part, 1);
  assert.deepEqual(parseVideo(`https://www.bilibili.com/video/${BV}/?p=2&tracking=secret`), { bvid: BV, part: 2, url: `https://www.bilibili.com/video/${BV}/?p=2` });
  for (const input of [`https://www.bilibili.com.evil.test/video/${BV}`, `http://www.bilibili.com/video/${BV}`, `https://evil.test@www.bilibili.com/video/${BV}`, `https://www.bilibili.com/video/${BV}?p=0`, "https://b23.tv/example", "../etc/passwd"]) assert.throws(() => parseVideo(input));
});
test("字幕下载地址不接受私网、非HTTPS、用户名、端口或伪装域名", () => {
  assert.equal(subtitleUrl("//aisubtitle.hdslb.com/subtitle/example.json"), "https://aisubtitle.hdslb.com/subtitle/example.json");
  for (const value of ["http://aisubtitle.hdslb.com/x", "https://127.0.0.1/x", "https://aisubtitle.hdslb.com.evil.test/x", "https://user@aisubtitle.hdslb.com/x", "https://aisubtitle.hdslb.com:444/x"]) assert.throws(() => subtitleUrl(value));
});
test("指定分P与时间戳正确，Cookie不发给字幕CDN，重复读取使用本地材料", async () => {
  const f = await fixture();
  try {
    await f.store.saveCredentials({ sessdata: "NOT_A_REAL_COOKIE", bili_jct: "DUMMY" });
    const calls: string[] = [];
    const mock: typeof fetch = async (input, options) => {
      const url = new URL(String(input)); calls.push(url.pathname);
      assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error");
      if (url.hostname === "api.bilibili.com") assert.match(new Headers(options.headers).get("cookie")!, /NOT_A_REAL_COOKIE/);
      else assert.equal(new Headers(options?.headers).has("cookie"), false);
      if (url.pathname.endsWith("/nav")) return json({ code: 0, data: { isLogin: true, wbi_img: IMAGES } });
      if (url.pathname.endsWith("/view")) return json({ code: 0, data: { title: "课程", owner: { name: "作者" }, cid: 100, duration: 90,
        pages: [{ cid: 100, duration: 90, part: "第一课" }, { cid: 200, duration: 10, part: "第二课" }] } });
      if (url.pathname.endsWith("/v2")) {
        assert.equal(url.searchParams.get("cid"), "200"); assert.ok(url.searchParams.has("w_rid"));
        return json({ code: 0, data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "https://aisubtitle.hdslb.com/sample.json?auth_key=DUMMY_KEY" }] } } });
      }
      return json({ body: [{ from: 0.5, to: 10, content: "第二课内容" }] });
    };
    const provider = new BilibiliProvider(f.store, mock);
    const result = await provider.load(`https://www.bilibili.com/video/${BV}?p=2`, "zh-CN");
    assert.equal(result.cid, 200); assert.equal(result.part, 2); assert.equal(result.duration, 10);
    assert.equal(result.segments[0]!.start, 0.5); assert.match(result.title, /P2/);
    const stored = JSON.stringify(result);
    assert.equal(stored.includes("NOT_A_REAL_COOKIE"), false); assert.equal(stored.includes("DUMMY_KEY"), false);
    const repeated = await provider.load(`https://www.bilibili.com/video/${BV}?p=2`, "zh-CN");
    assert.equal(repeated.id, result.id); assert.equal(calls.length, 4);
  } finally { await f.cleanup(); }
});
test("登录失效不是无字幕，也不会尝试继续读取", async () => {
  const f = await fixture();
  try {
    await f.store.saveCredentials({ sessdata: "DUMMY" }); let calls = 0;
    const provider = new BilibiliProvider(f.store, async () => { calls++; return json({ code: -101 }); });
    await assert.rejects(provider.load(BV, "zh-CN"), /登录态/); assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});
test("非JSON响应不伪装成无字幕，不回显敏感响应正文", async () => {
  const f = await fixture();
  try {
    await f.store.saveCredentials({ sessdata: "DUMMY" });
    const provider = new BilibiliProvider(f.store, async () => new Response("<html>LEAK_ME</html>", { status: 200 }));
    await assert.rejects(provider.load(BV, "zh-CN"), error => String(error).includes("有效 JSON") && !String(error).includes("LEAK_ME"));
  } finally { await f.cleanup(); }
});
test("平台明确无字幕时不给出基于简介的冒充全文", async () => {
  const f = await fixture();
  try {
    await f.store.saveCredentials({ sessdata: "DUMMY" });
    const provider = new BilibiliProvider(f.store, async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/nav")) return json({ code: 0, data: { isLogin: true, wbi_img: IMAGES } });
      if (url.pathname.endsWith("/view")) return json({ code: 0, data: { title: "课程", cid: 1, owner: { name: "作者" }, pages: [{ cid: 1 }] } });
      return json({ code: 0, data: { subtitle: { subtitles: [], ai_status: 0 } } });
    });
    await assert.rejects(provider.load(BV, "zh-CN"), error => String(error).includes("NO_SUBTITLES") || (error as { code?: string }).code === "NO_SUBTITLES");
    assert.equal((await f.store.list("materials")).length, 1); // Only the fixture's imported material exists.
  } finally { await f.cleanup(); }
});
