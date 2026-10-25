import { createTrafficGuard } from "../vendor/dsh-bili-whale/traffic.mjs";
import { signWbi } from "../vendor/dsh-bili-whale/sign-wbi.mjs";
import { hash, object, text, validateSegments } from "./validate.ts";
import { LearnError } from "./types.ts";
import type { Credentials, Material, VideoSource } from "./types.ts";
import { Store } from "./store.ts";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const BACKUP_SUBTITLE = "/x/v2/subtitle/web/view";
const API_PATHS = new Set(["/x/web-interface/nav", "/x/web-interface/wbi/view", "/x/player/wbi/v2", BACKUP_SUBTITLE, "/x/player/wbi/playurl"]);

/** Only this typed result permits offering visual sampling; other failures must stop. */
export class SubtitlesUnavailable extends LearnError {
  readonly source: VideoSource;
  constructor(source: VideoSource, reason = "两个字幕接口均未提供可用字幕轨道。") {
    super("NO_SUBTITLES", `${reason} 可以在用户确认后生成采样画面概要，或用 /learn import 导入字幕；不会将简介、评论冒充全文。`);
    this.source = source;
  }
}
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
export function publicContentHeaders(referer: string): Record<string, string> {
  return { "user-agent": USER_AGENT, referer };
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
  if (response.status === 412 || response.status === 429) throw new LearnError("RATE_LIMITED", "Bilibili 要求暂停，不会自动连续重试或切换提取方式。");
  if (response.status === 401) throw new LearnError("NEED_LOGIN", "登录态已失效，请重新运行 /learn auth。");
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
function tracksOf(data: Record<string, unknown>): Record<string, unknown>[] {
  const subtitle = object(data.subtitle ?? {});
  if (subtitle.subtitles === undefined) return [];
  if (!Array.isArray(subtitle.subtitles) || subtitle.subtitles.length > 100) throw new LearnError("UPSTREAM_ERROR", "平台字幕列表格式异常，不能按无字幕处理。");
  return subtitle.subtitles.map(object);
}
export class BilibiliProvider {
  readonly store: Store;
  readonly transport: typeof fetch;
  constructor(store: Store, transport: typeof fetch = globalThis.fetch) { this.store = store; this.transport = transport; }
  async guard() { return createTrafficGuard({ directory: await this.store.directory("traffic"), transport: this.transport }); }
  async resume(): Promise<void> {
    const c = await this.store.credentials();
    await (await this.guard()).resume(credentialHeaders(c));
  }
  private async api(apiPath: string, query: string, credentials: Credentials, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    if (!API_PATHS.has(apiPath)) throw new LearnError("UNSAFE_REQUEST", "请求不在只读接口白名单内。");
    let result: Record<string, unknown>;
    try {
      const response = await (await this.guard()).fetch(`https://api.bilibili.com${apiPath}${query ? `?${query}` : ""}`, {
        method: "GET", headers: credentialHeaders(credentials), redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
      if (apiPath === BACKUP_SUBTITLE && [404, 405].includes(response.status)) {
        await response.body?.cancel();
        throw new LearnError("SUBTITLE_ENDPOINT_UNAVAILABLE", "备用字幕接口不存在或不支持当前请求，未将其误认为已确认无字幕。");
      }
      result = await responseJson(response);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof LearnError) throw error;
      if ((error as { code?: string }).code === "BILI_TRAFFIC_PAUSED") throw new LearnError("TRAFFIC_PAUSED", "请求保护已暂停访问，请稍后重试；登录或验证码问题处理后运行 /learn resume。");
      throw new LearnError("NETWORK_ERROR", "无法获取 Bilibili 内容，请检查网络；未记录请求凭据或签名地址。");
    }
    const rawCode = result.code;
    const code = typeof rawCode === "number" || (typeof rawCode === "string" && /^-?[0-9]+$/.test(rawCode)) ? Number(rawCode) : NaN;
    if (code === -101 || code === -4003) throw new LearnError("NEED_LOGIN", "登录态无效或无权访问该视频，请在浏览器确认。");
    if ([12015, -105].includes(code)) throw new LearnError("VERIFICATION_REQUIRED", "请在浏览器手动处理验证码，然后运行 /learn resume；没有切换接口绕过。");
    if ([-412, -352, -799, -509, -10403].includes(code)) throw new LearnError("RATE_LIMITED", "平台限制访问，已暂停请求，请稍后重试。");
    if (code !== 0) throw new LearnError("UPSTREAM_ERROR", `平台接口返回错误码 ${Number.isFinite(code) ? code : "unknown"}，没有将它当作无字幕。`);
    return object(result.data);
  }
  private async signingImages(credentials: Credentials, signal?: AbortSignal) {
    const nav = await this.api("/x/web-interface/nav", "", credentials, signal);
    if (nav.isLogin !== true) throw new LearnError("NEED_LOGIN", "Bilibili 没有确认当前登录态，请重新运行 /learn auth。");
    const images = object(nav.wbi_img);
    return { img_url: text(images.img_url, "签名材料"), sub_url: text(images.sub_url, "签名材料") };
  }
  async load(input: string, language: string, signal?: AbortSignal): Promise<Material> {
    const video = parseVideo(input);
    const c = await this.store.credentials();
    const cacheId = `source-${hash([video.bvid, video.part, language, hash(c.sessdata)])}`;
    const cached = await this.store.read<{ materialId: string; at: number }>("jobs", cacheId);
    if (cached && Date.now() - cached.at < 24 * 3600_000) return this.store.material(cached.materialId);
    const images = await this.signingImages(c, signal);
    const view = await this.api("/x/web-interface/wbi/view", signWbi({ bvid: video.bvid }, images), c, signal);
    const pages = Array.isArray(view.pages) ? view.pages.map(object) : [{ cid: view.cid, duration: view.duration }];
    const page = pages[video.part - 1];
    if (!page) throw new LearnError("INVALID_PART", `视频只有 ${pages.length} 个分 P，请检查链接中的 p 参数。`);
    const cid = Number(page.cid);
    if (!Number.isSafeInteger(cid) || cid < 1) throw new LearnError("UPSTREAM_ERROR", "平台未返回有效的分 P 标识。");
    const duration = Number(page.duration ?? view.duration), aid = Number(view.aid);
    const source: VideoSource = {
      bvid: video.bvid, cid, part: video.part, sourceUrl: video.url,
      title: text(view.title, "视频标题", 1000) + (pages.length > 1 ? ` · P${video.part} ${String(page.part ?? "")}` : ""),
      author: text(object(view.owner).name, "作者", 300),
      ...(Number.isSafeInteger(aid) && aid > 0 ? { aid } : {}),
      ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
    };
    const player = await this.api("/x/player/wbi/v2", signWbi({ bvid: video.bvid, cid }, images), c, signal);
    let tracks = tracksOf(player);
    let subtitleSource = "主字幕接口";
    if (!tracks.length) {
      if (Number(object(player.subtitle ?? {}).ai_status) === 2) throw new LearnError("SUBTITLES_PENDING", "平台字幕仍在生成，请稍后手动重试。");
      if (!source.aid) throw new LearnError("UPSTREAM_ERROR", "平台缺少视频 aid，无法核对备用字幕；没有当作无字幕处理。");
      const query = new URLSearchParams({ oid: String(source.aid), pid: String(source.aid),
        context_ext: JSON.stringify({ video_type: 1 }), type: "1", cur_production_type: "0", preferred_language: `ai-${language.split("-")[0]!.toLowerCase()}`, playlist_switch: "0" });
      let backup: Record<string, unknown>;
      try { backup = await this.api(BACKUP_SUBTITLE, query.toString(), c, signal); }
      catch (error) {
        if (error instanceof LearnError && error.code === "SUBTITLE_ENDPOINT_UNAVAILABLE") throw new SubtitlesUnavailable(source, "主接口字幕列表为空，备用接口不可用，尚不能确认平台完全没有字幕。");
        throw error;
      }
      tracks = tracksOf(backup);
      if (tracks.length) {
        // The backup uses aid, not cid. P2+ requires proof; explicit P1 mismatches also fail closed.
        const subtitleInfo = object(backup.subtitle ?? {});
        const returnedCid = Number(backup.cid ?? subtitleInfo.cid);
        if (video.part > 1 || backup.cid !== undefined || subtitleInfo.cid !== undefined || tracks.some(track => track.cid !== undefined)) {
          tracks = tracks.filter(track => Number(track.cid ?? returnedCid) === cid);
          if (!tracks.length) throw new SubtitlesUnavailable(source, "主接口未提供该分 P 字幕；备用字幕无法确认 cid 匹配，已拒绝误用其他分 P 的内容。");
        }
      }
      subtitleSource = "备用字幕接口";
    }
    if (!tracks.length) throw new SubtitlesUnavailable(source);
    const preferred = language.toLowerCase().startsWith("zh") ? ["zh-CN", "zh", "ai-zh"] : [language, language.split("-")[0], `ai-${language.split("-")[0]}`];
    const track = preferred.map(lan => tracks.find(t => t.lan === lan)).find(Boolean) ?? tracks[0]!;
    const trackLanguage = text(track.lan, "字幕语言", 80);
    let body: Record<string, unknown>;
    try {
      body = await responseJson(await (await this.guard()).fetch(subtitleUrl(track.subtitle_url), {
        method: "GET", headers: publicContentHeaders(video.url), redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      }));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof LearnError) throw error;
      throw new LearnError("SUBTITLE_DOWNLOAD_FAILED", "字幕下载失败，可能是授权地址过期或网络问题；请稍后手动重试。");
    }
    if (Array.isArray(body.body) && body.body.length === 0) throw new SubtitlesUnavailable(source, "平台返回了字幕轨，但字幕正文为空。");
    const segments = validateSegments(body.body);
    const warnings = [`字幕来自${subtitleSource}；仅依据字幕整理，未分析视频画面或音频，字幕可能存在识别错误。`];
    const end = Math.max(...segments.map(s => s.end));
    if (source.duration && (end < source.duration * 0.9 || end > source.duration * 1.1)) warnings.push("字幕时间跨度与视频时长有较大差异，可能不完整或时间轴不匹配，请回看原视频。");
    const material = await this.store.saveMaterial({ schemaVersion: 1, kind: "bilibili-subtitle", ...source,
      language: trackLanguage, segments, warnings, fetchedAt: new Date().toISOString() });
    await this.store.write("jobs", cacheId, { materialId: material.id, at: Date.now() });
    return material;
  }

  /** Called only after explicit visual-sampling consent. No Cookie is returned to the caller. */
  async playback(source: VideoSource, signal?: AbortSignal): Promise<string> {
    const c = await this.store.credentials();
    const images = await this.signingImages(c, signal);
    const data = await this.api("/x/player/wbi/playurl", signWbi({ bvid: source.bvid, cid: source.cid, qn: 64, fnval: 16, fnver: 0, fourk: 0 }, images), c, signal);
    if (data.is_preview === true || Number(data.is_preview) === 1 || data.need_vip === true || Number(data.need_vip) === 1) throw new LearnError("MEDIA_RESTRICTED", "平台只提供预览或要求额外访问权限，不下载或尝试绕过。");
    const dash = data.dash ? object(data.dash) : undefined;
    const video = Array.isArray(dash?.video) ? dash.video.map(object) : [];
    if (video.length) {
      const mp4 = video.filter(item => String(item.mimeType ?? item.mime_type ?? "video/mp4") === "video/mp4");
      const avc = mp4.filter(item => Number(item.codecid) === 7);
      const choices = avc.length ? avc : mp4;
      choices.sort((a, b) => {
        const ah = Number(a.height) || 0, bh = Number(b.height) || 0;
        const as = ah >= 720 ? ah : 10000 - ah, bs = bh >= 720 ? bh : 10000 - bh;
        return as - bs || Number(a.bandwidth ?? 0) - Number(b.bandwidth ?? 0);
      });
      if (choices[0]) return text(choices[0].baseUrl ?? choices[0].base_url, "视频媒体地址", 16000);
    }
    const parts = Array.isArray(data.durl) ? data.durl.map(object) : [];
    if (parts.length === 1) return text(parts[0]!.url, "视频媒体地址", 16000);
    throw new LearnError("MEDIA_UNAVAILABLE", "未取得受支持的完整 MP4 视频流；不会只处理第一段或绕过访问限制。");
  }
}
