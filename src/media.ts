import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { assertDirectory, safeChildDirectory } from "./files.ts";
import { LearnError } from "./types.ts";
import type { Material, ModelRequest, VideoSource } from "./types.ts";
import { hash, validateVisualAssets } from "./validate.ts";
import { publicContentHeaders } from "./bilibili.ts";
import type { BilibiliProvider } from "./bilibili.ts";
import type { Store } from "./store.ts";

export const MAX_VISUAL_FRAMES = 24;
export const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const VERSION = "visual-v1";
const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const filename = (index: number) => `frame-${String(index).padStart(2, "0")}.jpg`;

/** Discover an existing binary only. Never install packages or download executable code. */
export async function findFfmpeg(): Promise<string> {
  const configured = process.env.NIBBLEARN_FFMPEG_PATH || process.env.FFMPEG;
  if (configured && !path.isAbsolute(configured)) throw new LearnError("FFMPEG_PATH", "FFmpeg 程序路径必须是绝对路径。");
  const candidates = configured ? [configured] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
    .map(directory => path.join(directory.replace(/^"|"$/g, ""), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
  for (const file of candidates) {
    try { if ((await fs.stat(file)).isFile()) { await fs.access(file, constants.X_OK); return path.resolve(file); } }
    catch { /* Try another existing PATH entry. */ }
  }
  throw new LearnError("FFMPEG_REQUIRED", "视觉采样需要已安装的 FFmpeg。请自行安装并重启 pi，或设置 NIBBLEARN_FFMPEG_PATH；插件不会自动下载安装。也可用 /learn import 导入字幕。");
}
export function mediaUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.startsWith("//") ? `https:${input}` : input); }
  catch { throw new LearnError("UNSAFE_MEDIA_URL", "平台返回了无效的媒体地址。"); }
  const hosts = ["bilivideo.com", "bilivideo.cn", "hdslb.com", "bilibili.com"];
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new LearnError("UNSAFE_MEDIA_URL", "媒体地址不在 HTTPS Bilibili CDN 白名单内，不传递 Cookie，也不跟随重定向。");
  }
  return url.href;
}
async function readImage(directory: string, index: number, expected?: string): Promise<Buffer> {
  await assertDirectory(directory);
  const file = path.join(directory, filename(index));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES) throw new LearnError("INVALID_VISUAL_IMAGE", "采样图片不是普通文件或超过 3 MiB 上限。");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw new LearnError("INVALID_VISUAL_IMAGE", "图片读取期间超过大小上限。");
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff || data.at(-2) !== 0xff || data.at(-1) !== 0xd9
      || (expected !== undefined && digest(data) !== expected)) throw new LearnError("INVALID_VISUAL_IMAGE", "采样图片格式或校验值不符，已停止发送给模型。");
    return data;
  } finally { await handle.close(); }
}
export async function visualImages(store: Store, material: Material, indexes: number[]): Promise<NonNullable<ModelRequest["images"]>> {
  try {
    if (material.kind !== "bilibili-visual") throw new LearnError("INVALID_VISUAL_MATERIAL", "该材料不是画面采样。");
    const visual = validateVisualAssets(material.visual, material.segments);
    const directory = path.join(await store.directory("materials"), visual.directory);
    const images: NonNullable<ModelRequest["images"]> = [];
    for (const index of indexes) {
      if (!Number.isSafeInteger(index) || index < 0 || !visual.frames[index]) throw new LearnError("INVALID_VISUAL_MATERIAL", "画面索引超出当前材料范围。");
      const bytes = await readImage(directory, index, visual.frames[index]!.sha256);
      images.push({ data: bytes.toString("base64"), mimeType: "image/jpeg" });
    }
    return images;
  } catch (error) {
    if (error instanceof LearnError) throw error;
    throw new LearnError("VISUAL_CACHE_READ", "无法读取画面缓存，请检查缓存是否存在及本机文件权限；未回显本地路径。");
  }
}
async function runFfmpeg(executable: string, input: string, output: string, time: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(30000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // A single JPEG contains the whole frame above, plus its bottom text region below.
  // Force the local MOV/MP4 demuxer: do not let a downloaded manifest open remote URLs.
  const filter = "[0:v]split=2[all][text];[all]scale=960:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[full];[text]crop=iw:ih*0.4:0:ih*0.6,scale=1280:480:force_original_aspect_ratio=decrease,pad=1280:480:(ow-iw)/2:(oh-ih)/2[strip];[full][strip]vstack=inputs=2[image]";
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ["-nostdin", "-y", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0", "-ss", time.toFixed(3), "-i", input,
        "-filter_complex", filter, "-map", "[image]", "-an", "-frames:v", "1", "-q:v", "3", "-threads", "1", output],
      { shell: false, windowsHide: true, stdio: "ignore", signal: combined });
      let failed = false;
      child.on("error", () => { failed = true; });
      child.on("close", code => {
        if (failed || code !== 0) reject(new LearnError("FRAME_EXTRACTION_FAILED", "FFmpeg 抽帧失败或视频编码不支持；未回显本地路径或媒体签名。"));
        else resolve();
      });
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new LearnError("FRAME_TIMEOUT", "单帧处理超过 30 秒，已终止本次 FFmpeg 子进程。");
    if (error instanceof LearnError) throw error;
    throw new LearnError("FRAME_EXTRACTION_FAILED", "无法启动 FFmpeg，请检查安装路径；未执行 shell 命令。");
  }
}
async function download(provider: BilibiliProvider, source: VideoSource, destination: string, signal?: AbortSignal): Promise<void> {
  const url = mediaUrl(await provider.playback(source, signal));
  const timeout = AbortSignal.timeout(180000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const handle = await fs.open(destination, "wx", 0o600);
  try {
    const response = await provider.transport(url, { method: "GET", headers: publicContentHeaders(source.sourceUrl), redirect: "error", signal: combined });
    if ([412, 429].includes(response.status)) { await response.body?.cancel(); throw new LearnError("RATE_LIMITED", "媒体服务器要求暂停，请等待后人工重试；没有自动重试或切换地址。"); }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new LearnError("MEDIA_DOWNLOAD_FAILED", "未取得完整媒体响应，可能是授权过期、部分内容或访问限制；不会回显签名地址。");
    }
    if (Number(response.headers.get("content-length")) > MAX_MEDIA_BYTES) { await response.body.cancel(); throw new LearnError("MEDIA_TOO_LARGE", "视频流超过 256 MiB 上限，请使用更短的分 P 或导入字幕。"); }
    let bytes = 0;
    for await (const chunk of response.body) {
      combined.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > MAX_MEDIA_BYTES) throw new LearnError("MEDIA_TOO_LARGE", "下载达到 256 MiB 上限，已停止并删除临时视频。");
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await handle.write(chunk, offset, chunk.byteLength - offset);
        if (written.bytesWritten < 1) throw new LearnError("MEDIA_DOWNLOAD_FAILED", "媒体写入没有进展，已停止下载。");
        offset += written.bytesWritten;
      }
    }
    if (!bytes) throw new LearnError("MEDIA_DOWNLOAD_FAILED", "媒体内容为空，不能据此生成画面草稿。");
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new LearnError("MEDIA_TIMEOUT", "视频下载超过 3 分钟，已停止并删除临时文件。");
    if (error instanceof LearnError) throw error;
    throw new LearnError("MEDIA_DOWNLOAD_FAILED", "媒体请求或流式下载失败，未回显 Cookie、签名地址或底层请求详情。");
  } finally { await handle.close(); }
}

/** Caller must obtain real human consent for downloading media and sending images first. */
export async function prepareVisual(provider: BilibiliProvider, source: VideoSource, maxFrames = MAX_VISUAL_FRAMES, signal?: AbortSignal, progress: (message: string) => void = () => {}): Promise<Material> {
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_VISUAL_FRAMES) throw new LearnError("VISUAL_BUDGET", "画面采样上限必须为 1 至 24。");
  if (!source.duration || !Number.isFinite(source.duration) || source.duration <= 0) throw new LearnError("VISUAL_DURATION", "平台未提供该分 P 的有效时长，无法安全安排全程采样。");
  const relative = path.relative(SOURCE_ROOT, provider.store.home);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new LearnError("VISUAL_DIRECTORY", "视频与画面缓存必须放在源码仓库外，请在启动 pi 前设置 NIBBLEARN_HOME。");
  const count = Math.min(maxFrames, Math.max(1, Math.ceil(source.duration / 7)));
  // Match subtitle caching: switching login sessions must not silently reuse another session's media.
  const session = hash((await provider.store.credentials()).sessdata);
  const key = hash([VERSION, source.bvid, source.cid, source.duration, count, session]);
  try { return await provider.store.lock(`visual-${key}`, async () => {
    signal?.throwIfAborted();
    const cached = await provider.store.read<{ materialId: string; at: number }>("jobs", `visual-source-${key}`);
    if (cached) {
      const material = await provider.store.material(cached.materialId);
      if (material.kind !== "bilibili-visual" || material.bvid !== source.bvid || material.cid !== source.cid
        || material.visual?.directory !== `visual-${key}` || material.segments.length !== count) throw new LearnError("INVALID_VISUAL_MATERIAL", "缓存与当前分 P 不一致，已停止复用。");
      return material;
    }
    const executable = await findFfmpeg();
    const materials = await provider.store.directory("materials");
    const name = `visual-${key}`;
    const existing = path.join(materials, name);
    try { await fs.lstat(existing); throw new LearnError("VISUAL_CACHE_EXISTS", "画面缓存目录已存在但没有可复用记录，请先人工检查该专用缓存，未覆盖文件。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const directory = await safeChildDirectory(materials, name);
    const video = path.join(directory, "source.mp4");
    let committed = false;
    try {
      await fs.writeFile(path.join(directory, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
      progress("没有可用字幕，正在下载当前分 P 的视频流（最多 256 MiB，仅用于抽帧，不进行语音转写）…");
      await download(provider, source, video, signal);
      const times = Array.from({ length: count }, (_, index) => Number((source.duration! * (index + 0.5) / count).toFixed(3)));
      const frames: NonNullable<Material["visual"]>["frames"] = [];
      for (const [index, time] of times.entries()) {
        signal?.throwIfAborted();
        progress(`正在提取第 ${index + 1}/${count} 个画面及底部文字区域…`);
        await runFfmpeg(executable, video, path.join(directory, filename(index)), time, signal);
        const bytes = await readImage(directory, index);
        frames.push({ time, sha256: digest(bytes) });
      }
      await fs.rm(video, { force: true });
      signal?.throwIfAborted();
      const material = await provider.store.saveMaterial({ schemaVersion: 1, kind: "bilibili-visual", ...source,
        language: "visual", visual: { directory: name, frames },
        segments: times.map((time, index) => ({ start: time, end: time, text: `采样画面 #${index}：上部全景，下部为同帧的底部文字区域；不是视频台词。` })),
        warnings: ["本草稿仅依据采样画面及其中可见文字，不是字幕全文、语音转写或完整观看；没有处理音频。",
          `在该分 P 全程均匀采样 ${count} 个时间点，间隔约 ${(source.duration! / count).toFixed(1)} 秒；没有把长视频限制在开头一张拼图。`,
          "采样之间的画面、口头讲解和短暂出现的硬字幕可能遗漏；图像文字识别与时间定位可能有误，请回看原视频。"],
        fetchedAt: new Date().toISOString() });
      await provider.store.write("jobs", `visual-source-${key}`, { materialId: material.id, at: Date.now() });
      committed = true;
      return material;
    } finally {
      await fs.rm(video, { force: true });
      if (!committed) await fs.rm(directory, { recursive: true, force: true });
    }
  }); } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof LearnError) throw error;
    throw new LearnError("VISUAL_CACHE_IO", "画面缓存或文件操作失败，请检查磁盘空间和权限；未回显本地路径或媒体地址。");
  }
}
