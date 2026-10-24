import path from "node:path";
import { readText } from "./files.ts";
import { object, parseJson, validateSegments } from "./validate.ts";
import { LearnError } from "./types.ts";
import type { Material, Segment } from "./types.ts";

function seconds(value: string): number {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) throw new LearnError("INVALID_SUBTITLES", "字幕时间格式不正确。");
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}
export function parseSubtitleFile(raw: string, extension: string): Segment[] {
  if (extension.toLowerCase() === ".json") {
    const value = parseJson(raw);
    return validateSegments(Array.isArray(value) ? value : object(value).body ?? object(value).segments);
  }
  if (![".srt", ".vtt"].includes(extension.toLowerCase())) throw new LearnError("UNSUPPORTED_FILE", "请导入 SRT、VTT 或 Bilibili 字幕 JSON 文件。");
  const blocks = raw.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n\s*\n/);
  const segments: Segment[] = [];
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (!block.trim() || /^WEBVTT(?:\s|$)|^NOTE(?:\s|$)|^STYLE(?:\s|$)|^REGION(?:\s|$)/.test(block.trim())) continue;
    const position = lines.findIndex(line => line.includes("-->"));
    if (position < 0) throw new LearnError("INVALID_SUBTITLES", "字幕段落缺少时间轴；不会忽略无法识别的片段。");
    const [start, endAndOptions] = lines[position]!.split("-->");
    const end = endAndOptions?.trim().split(/\s+/)[0];
    if (!start || !end) throw new LearnError("INVALID_SUBTITLES", "字幕起止时间缺失。");
    const content = lines.slice(position + 1).join("\n").replace(/<[^>]*>/g, "").trim();
    segments.push({ start: seconds(start.trim()), end: seconds(end), text: content });
  }
  return validateSegments(segments);
}
export async function importSubtitle(file: string): Promise<Omit<Material, "id">> {
  const segments = parseSubtitleFile(await readText(file), path.extname(file));
  return {
    schemaVersion: 1, kind: "imported-subtitle", title: path.basename(file, path.extname(file)), author: "用户提供",
    language: "unknown", segments, fetchedAt: new Date().toISOString(),
    warnings: ["来自用户导入的字幕，未核验与视频是否对应；没有声称观看了画面或核实了原视频。"],
  };
}
