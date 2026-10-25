import path from "node:path";
import { createHash } from "node:crypto";
import { LearnError } from "./types.ts";
import type { Credentials, Plan, Reference, Segment, VisualAssets } from "./types.ts";

export function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LearnError("INVALID_DATA", "需要 JSON 对象。");
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 4000, optional = false): string {
  if (optional && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new LearnError("INVALID_DATA", `${name} 必须是非空文本，最长 ${max} 字符。`);
  }
  return value.trim();
}
export function id(value: unknown): string {
  const result = text(value, "ID", 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result)) throw new LearnError("INVALID_ID", "ID 只能包含字母、数字、下划线和连字符。");
  return result;
}
export function parseJson(raw: string): unknown {
  try { return JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { throw new LearnError("INVALID_JSON", "JSON 格式不正确。"); }
}
export function validatePlan(value: unknown): Plan {
  const p = object(value);
  const revision = p.revision;
  if (p.schemaVersion !== 1 || !Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new LearnError("INVALID_PLAN", "学习计划版本不正确。");
  }
  const outputDir = text(p.outputDir, "保存目录", 4000);
  if (!path.isAbsolute(outputDir)) throw new LearnError("INVALID_PLAN", "保存目录必须是绝对路径，请通过 /learn setup 配置。");
  if (typeof p.allowModelSupplement !== "boolean" || typeof p.consentModelTransfer !== "boolean") {
    throw new LearnError("INVALID_PLAN", "资料补充与模型传输许可必须明确设置为 true/false。");
  }
  if (!Array.isArray(p.references) || p.references.length > 10) throw new LearnError("INVALID_PLAN", "参考材料最多 10 份。");
  const references: Reference[] = p.references.map(value => {
    const r = object(value);
    return { id: id(r.id), title: text(r.title, "参考资料标题", 200), text: text(r.text, "参考资料", 8000) };
  });
  if (new Set(references.map(r => r.id)).size !== references.length || references.reduce((n, r) => n + r.text.length, 0) > 16000) {
    throw new LearnError("INVALID_PLAN", "参考资料 ID 不可重复，合计最多 16000 字符。");
  }
  return {
    schemaVersion: 1, id: id(p.id), revision: Number(revision),
    title: text(p.title, "计划名称", 200), topic: text(p.topic, "学习主题", 1000),
    goal: text(p.goal, "学习目标"), background: text(p.background, "已有基础", 2000, true),
    focus: text(p.focus, "范围与排除项", 2000, true), noteStyle: text(p.noteStyle, "笔记形式", 1000),
    language: text(p.language, "输出语言", 80), outputDir: path.resolve(outputDir),
    allowModelSupplement: p.allowModelSupplement, consentModelTransfer: p.consentModelTransfer, references,
  };
}
export function validateSegments(value: unknown): Segment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50000) throw new LearnError("NO_SUBTITLES", "没有可用字幕，或字幕条数超过上限。");
  let characters = 0;
  const segments = value.map(value => {
    const s = object(value);
    const start = s.start ?? s.from;
    const end = s.end ?? s.to;
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0 || typeof end !== "number" || !Number.isFinite(end) || end < start) {
      throw new LearnError("INVALID_SUBTITLES", "字幕必须包含有效的起止时间。");
    }
    const content = text(s.text ?? s.content, "字幕文本", 24000);
    characters += content.length;
    return { start, end, text: content };
  });
  if (characters > 120000) throw new LearnError("MATERIAL_TOO_LARGE", "字幕超过第一版 120000 字符上限，请按课程分 P 或片段处理；没有静默截断。");
  return segments.sort((a, b) => a.start - b.start);
}
export function validateVisualAssets(value: unknown, segments: Segment[]): VisualAssets {
  const visual = object(value);
  if (typeof visual.directory !== "string" || !/^visual-[a-f0-9]{64}$/.test(visual.directory)
    || !Array.isArray(visual.frames) || !visual.frames.length || visual.frames.length > 24 || visual.frames.length !== segments.length) {
    throw new LearnError("INVALID_VISUAL_MATERIAL", "画面缓存结构不正确，不能读取图片或按字幕处理。");
  }
  const frames = visual.frames.map((entry, index) => {
    const frame = object(entry), segment = segments[index]!;
    if (typeof frame.time !== "number" || !Number.isFinite(frame.time) || frame.time < 0
      || frame.time !== segment.start || frame.time !== segment.end || typeof frame.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(frame.sha256)) {
      throw new LearnError("INVALID_VISUAL_MATERIAL", "画面索引、时间戳或校验值无效。");
    }
    return { time: frame.time, sha256: frame.sha256 };
  });
  return { directory: visual.directory, frames };
}

export function validateCredentials(value: unknown): Credentials {
  const c = object(value);
  const clean = (value: unknown, required: boolean): string => {
    if (!required && (value === undefined || value === "")) return "";
    const result = text(value, "凭据字段", 6000);
    if (/[;\r\n\x00-\x20\x7f]/.test(result)) throw new LearnError("INVALID_CREDENTIALS", "凭据不能包含空白、分号或控制字符；只填写 Cookie 的值。");
    return result;
  };
  return { sessdata: clean(c.sessdata, true), bili_jct: clean(c.bili_jct, false), buvid3: clean(c.buvid3, false) };
}
