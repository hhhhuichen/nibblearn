import { createTrafficGuard } from "../vendor/dsh-bili-whale/traffic.mjs";
import { signWbi } from "../vendor/dsh-bili-whale/sign-wbi.mjs";
import { hash, object, text, validateSegments } from "./validate.ts";
import { LearnError } from "./types.ts";
import type { Credentials, Material } from "./types.ts";
import { Store } from "./store.ts";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const API_PATHS = new Set(["/x/web-interface/nav", "/x/web-interface/wbi/view", "/x/player/wbi/v2"]);
export function parseVideo(input: string): { bvid: string; part: number; url: string } {
  if (/^BV[a-zA-Z0-9]{10}$/.test(input)) return { bvid: input, part: 1, url: `https://www.bilibili.com/video/${input}/?p=1` };
  let url: URL;
  try { url = new URL(input); } catch { throw new LearnError("INVALID_VIDEO", "请提供 BV 号或完整 Bilibili 视频链接。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(url.hostname)) {
    throw new LearnError("INVALID_VIDEO", "只接受 HTTPS Bilibili 视频链接；b23 短链接请先在浏览器展开。");
  }
  const match = /^\/video\/(BV[a-zA-Z0-9]{10})\/?$/.exec(url.pathname);
  const p = url.searchParams.get("p") ?? "1";
  if (!match || !/^[1-9][0-9]*$/.test(p) || Number(p) > 10000) throw new LearnError("INVALID_VIDEO", "视频路径或分 P 参数无效。");
  return { bvid: match[1]!, part: Number(p), url: `https://www.bilibili.com/video/${match[1]}/?p=${p}` };
}
export function credentialHeaders(c: Credentials): Record<string, string> {
  const cookie = [`SESSDATA=${c.sessdata}`, ...(c.bili_jct ? [`bili_jct=${c.bili_jct}`] : []), ...(c.buvid3 ? [`buvid3=${c.buvid3}`] : [])].join("; ");
  return { "user-agent": USER_AGENT, referer: "https://www.bilibili.com/", cookie };
}
export function subtitleUrl(input: unknown): string {
  const raw = text(input, "字幕地址", 8000);
  let url: URL;
  try { url = new URL(raw.startsWith("//") ? `https:${raw}` : raw); }
  catch { throw new LearnError("UNSAFE_SUBTITLE_URL", "平台返回了无效的字幕地址。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !(url.hostname === "hdslb.com" || url.hostname.endsWith(".hdslb.com") || url.hostname.endsWith(".bilibili.com"))) {
    throw new LearnError("UNSAFE_SUBTITLE_URL", "拒绝向非 Bilibili 字幕域名请求，不传递账号 Cookie。");
  }
  return url.href;
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (response.status === 412 || response.status === 429) throw new LearnError("RATE_LIMITED", "Bilibili 要求暂停，已进入退避；不会自动连续重试。");
  if (response.status === 401) throw new LearnError("NEED_LOGIN", "登录态已失效，请在浏览器重新登录并更新凭据。");
  if (!response.ok) throw new LearnError("UPSTREAM_ERROR", `内容请求失败（HTTP ${response.status}），这不表示视频没有字幕。`);
  const max = 8 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > max) throw new LearnError("RESPONSE_TOO_LARGE", "平台返回内容超过大小限制。");
  if (!response.body) throw new LearnError("UPSTREAM_ERROR", "响应没有正文。");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > max) throw new LearnError("RESPONSE_TOO_LARGE", "平台返回内容超过大小限制。");
    chunks.push(chunk);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { throw new LearnError("UPSTREAM_ERROR", "平台没有返回有效 JSON，可能是登录、网络或接口变化；不能当作无字幕。"); }
}
export class BilibiliProvider {
  readonly store: Store;
  readonly transport: typeof fetch;
  constructor(store: Store, transport: typeof fetch = globalThis.fetch) { this.store = store; this.transport = transport; }
  async guard() {
    return createTrafficGuard({ directory: await this.store.directory("traffic"), transport: this.transport });
  }
  async resume(): Promise<void> {
    const c = await this.store.credentials();
    await (await this.guard()).resume(credentialHeaders(c));
  }
  async load(input: string, language: string, signal?: AbortSignal): Promise<Material> {
    const video = parseVideo(input);
    const c = await this.store.credentials();
    const cacheId = `source-${hash([video.bvid, video.part, language, hash(c.sessdata)])}`;
    const cached = await this.store.read<{ materialId: string; at: number }>("jobs", cacheId);
    if (cached && Date.now() - cached.at < 24 * 3600_000) return this.store.material(cached.materialId);
    const guard = await this.guard();
    const headers = credentialHeaders(c);
    const get = async (apiPath: string, query = "") => {
      signal?.throwIfAborted();
      if (!API_PATHS.has(apiPath)) throw new LearnError("UNSAFE_REQUEST", "请求不在只读接口白名单内。");
      let result: Record<string, unknown>;
      try {
        result = await responseJson(await guard.fetch(`https://api.bilibili.com${apiPath}${query ? `?${query}` : ""}`, {
          method: "GET", headers, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        }));
      } catch (error) {
        if (error instanceof LearnError) throw error;
        if (signal?.aborted) throw signal.reason;
        if ((error as { code?: string }).code === "BILI_TRAFFIC_PAUSED") throw new LearnError("TRAFFIC_PAUSED", "请求保护已暂停访问，请稍后重试；登录或验证码问题处理后运行 /learn resume。");
        throw new LearnError("NETWORK_ERROR", "无法获取 Bilibili 内容，请检查网络；未记录请求凭据或签名地址。");
      }
      const code = Number(result.code);
      if (code === -101 || code === -4003) throw new LearnError("NEED_LOGIN", "登录态无效或无权访问该视频，请在浏览器确认。");
      if ([-412, -352, -799, -509, -10403].includes(code)) throw new LearnError("RATE_LIMITED", "平台限制访问，已暂停请求，请稍后重试。");
      if (code !== 0) throw new LearnError("UPSTREAM_ERROR", `平台接口返回错误码 ${Number.isFinite(code) ? code : "unknown"}，没有将它当作无字幕。`);
      return object(result.data);
    };
    const nav = await get("/x/web-interface/nav");
    if (nav.isLogin === false) throw new LearnError("NEED_LOGIN", "Bilibili 登录态已失效。");
    const images = object(nav.wbi_img);
    const signingImages = { img_url: text(images.img_url, "签名材料"), sub_url: text(images.sub_url, "签名材料") };
    const view = await get("/x/web-interface/wbi/view", signWbi({ bvid: video.bvid }, signingImages));
    const pages = Array.isArray(view.pages) ? view.pages.map(object) : [{ cid: view.cid, duration: view.duration }];
    const page = pages[video.part - 1];
    if (!page) throw new LearnError("INVALID_PART", `视频只有 ${pages.length} 个分 P，请检查链接中的 p 参数。`);
    const cid = Number(page.cid);
    if (!Number.isSafeInteger(cid) || cid < 1) throw new LearnError("UPSTREAM_ERROR", "平台未返回有效的分 P 标识。");
    const player = await get("/x/player/wbi/v2", signWbi({ bvid: video.bvid, cid }, signingImages));
    const subtitle = object(player.subtitle ?? {});
    const tracks = Array.isArray(subtitle.subtitles) ? subtitle.subtitles.map(object) : [];
    if (!tracks.length) {
      if (Number(subtitle.ai_status) === 2) throw new LearnError("SUBTITLES_PENDING", "平台字幕仍在生成，请稍后手动重试。");
      throw new LearnError("NO_SUBTITLES", "平台未提供可用字幕。第一版不把简介、评论或少量画面冒充全文；可用 /learn import 导入转写字幕。");
    }
    const preferred = language.toLowerCase().startsWith("zh") ? ["zh-CN", "zh", "ai-zh"] : [language, language.split("-")[0], `ai-${language.split("-")[0]}`];
    const track = preferred.map(lan => tracks.find(t => t.lan === lan)).find(Boolean) ?? tracks[0]!;
    const trackLanguage = text(track.lan, "字幕语言", 80);
    let body: Record<string, unknown>;
    try {
      body = await responseJson(await guard.fetch(subtitleUrl(track.subtitle_url), {
        method: "GET", headers: { "user-agent": USER_AGENT, referer: video.url }, redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      }));
    } catch (error) {
      if (error instanceof LearnError) throw error;
      if (signal?.aborted) throw signal.reason;
      throw new LearnError("SUBTITLE_DOWNLOAD_FAILED", "字幕下载失败，可能是授权地址过期或网络问题；请稍后手动重试。");
    }
    const segments = validateSegments(body.body);
    const duration = Number(page.duration ?? view.duration);
    const warnings = ["仅依据字幕整理，未分析视频画面、动作、图表或音频；字幕内容本身可能存在识别错误。"];
    const end = Math.max(...segments.map(s => s.end));
    if (Number.isFinite(duration) && duration > 0 && (end < duration * 0.9 || end > duration * 1.1)) warnings.push("字幕时间跨度与视频时长有较大差异，可能不完整或时间轴不匹配，请回看原视频。");
    const material = await this.store.saveMaterial({
      schemaVersion: 1, kind: "bilibili-subtitle", bvid: video.bvid, cid, part: video.part, sourceUrl: video.url,
      title: text(view.title, "视频标题", 1000) + (pages.length > 1 ? ` · P${video.part} ${String(page.part ?? "")}` : ""),
      author: text(object(view.owner).name, "作者", 300), language: trackLanguage,
      ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}), segments, warnings, fetchedAt: new Date().toISOString(),
    });
    await this.store.write("jobs", cacheId, { materialId: material.id, at: Date.now() });
    return material;
  }
}
