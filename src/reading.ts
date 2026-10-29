import { cleanMarkdown } from "./notes.ts";
import { validateReviewedMarkdown } from "./review.ts";
import type { Store } from "./store.ts";
import { LearnError } from "./types.ts";
import type { Draft } from "./types.ts";
import { emptyUsage } from "./usage.ts";
import { hash, id } from "./validate.ts";

const VERSION = "index-free-reading-v1";
const INDEX_TITLES = new Set(["字幕来源索引", "画面来源索引（不是台词）", "来源索引", "来源说明"]);
const SOURCE_ID = /^(?:U[1-9][0-9]*|(?:(?:(?:V[1-9][0-9]*-)?P|S)[1-9][0-9]*-)?E[1-9][0-9]*)$/i;
const LABEL = /^(?:E[1-9][0-9]*|[1-9][0-9]*·(?:字幕讲义|采样画面旧描述|模型补充（非视频原话）|用户参考（非视频原话）|材料疑点|编辑补注（非视频原话）))$/;
const NOTICE = "> 无索引阅读版：仅省略来源编号和时间定位，不补齐原材料缺口，也不代表知识、公式或代码已核验。完整来源保留在带索引原稿及本机材料中。";

interface Line { text: string; outsideCode: boolean }
/** Only template control lines outside closed fences can be removed. */
function linesOf(markdown: string): Line[] {
  let fence: { char: string; size: number } | undefined;
  const result = markdown.split(/\r?\n/).map(text => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.size && !marker[2]!.trim()) fence = undefined;
      return { text, outsideCode: false };
    }
    if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      fence = { char: marker[1]![0]!, size: marker[1]!.length };
      return { text, outsideCode: false };
    }
    return { text, outsideCode: true };
  });
  if (fence) throw new LearnError("READING_FORMAT_UNSUPPORTED", "草稿有未闭合代码块，不能安全移除来源索引；请先审核修正带索引原稿。");
  return result;
}

/** Mask complete inline code spans when checking for dangling source links. */
function prose(line: string): string {
  const runs = [...line.matchAll(/`+/g)], next = new Map<number, number>(), closing: number[] = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    closing[i] = next.get(runs[i]![0].length) ?? -1;
    next.set(runs[i]![0].length, i);
  }
  let result = "", start = 0;
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]!;
    let escapes = 0;
    for (let at = open.index - 1; at >= 0 && line[at] === "\\"; at--) escapes++;
    if (escapes % 2 || closing[i]! < 0) continue;
    const close = runs[closing[i]!]!;
    result += line.slice(start, open.index);
    start = close.index + close[0].length;
    i = closing[i]!;
  }
  return result + line.slice(start);
}

function stripIndexes(markdown: string): string {
  const lines = linesOf(markdown), kept: Line[] = [], anchors = new Set<string>();
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, title = line.outsideCode ? /^## (.+?)\s*$/.exec(line.text)?.[1] : undefined;
    if (!title || !INDEX_TITLES.has(title)) { kept.push(line); continue; }
    let end = i + 1;
    while (end < lines.length) {
      const item = lines[end]!;
      const footer = item.outsideCode && item.text === "---" && [
        "由 Nibblearn 辅助整理。请核对原始材料；模型补充不等于已核验事实。",
        "由 Nibblearn 辅助重编；保留来源不等于内容已经核验。",
      ].includes(lines[end + 1]?.text ?? "");
      if (footer || (item.outsideCode && /^#{1,2} /.test(item.text))) break;
      end++;
    }
    const ids = lines.slice(i + 1, end).flatMap(item => {
      const key = item.outsideCode ? /^#{3,6} ([A-Za-z0-9-]+)\s*$/.exec(item.text)?.[1] : undefined;
      return key && SOURCE_ID.test(key) ? [key.toLowerCase()] : [];
    });
    if (!ids.length) throw new LearnError("READING_FORMAT_UNSUPPORTED", "无法识别来源索引的编号结构，未冒险删除自定义章节；请保留索引版或先审核原稿。");
    ids.forEach(key => anchors.add(key));
    removed++; i = end - 1;
  }
  if (!removed) throw new LearnError("READING_NO_INDEX", "该正文没有可识别的生成式来源索引，不需要自动转换，原稿未修改。");
  const output: string[] = [];
  for (const line of kept) {
    if (!line.outsideCode) { output.push(line.text); continue; }
    const definition = /^\[(u[1-9][0-9]*)\]: #\1\s*$/i.exec(line.text);
    if (definition && anchors.has(definition[1]!.toLowerCase())) continue;
    if (line.text.startsWith("来源：")) {
      const citations = [...line.text.matchAll(/\[([^\]\n]+)\](?:\(#([a-z0-9-]+)\)|\[([a-z0-9-]+)\])/gi)];
      if (citations.length && citations.every(c => LABEL.test(c[1]!) && anchors.has((c[2] ?? c[3])!.toLowerCase()))) {
        const rest = line.text.slice("来源：".length).replace(/\[([^\]\n]+)\](?:\(#([a-z0-9-]+)\)|\[([a-z0-9-]+)\])/gi, "").replace(/、/g, "");
        if (!["", "（含旧稿采样画面描述，无声音）", "（含非视频原话的补充，未独立核验）", "（含旧稿采样画面描述，无声音；含非视频原话的补充，未独立核验）"].includes(rest)) {
          throw new LearnError("READING_FORMAT_UNSUPPORTED", "来源行含有自定义补注，不能在隐藏编号时一并删除；请先审核原稿。");
        }
        const notices: string[] = [];
        if (line.text.includes("采样画面旧描述")) notices.push("本节依据旧稿采样画面描述，无声音，不代表连续观看");
        if (/模型补充|用户参考|编辑补注/.test(line.text)) notices.push("含非视频原话的补充或参考，未独立核验");
        if (line.text.includes("材料疑点")) notices.push("涉及材料疑点，请结合正文与待核对项阅读");
        if (notices.length) output.push(`材料说明：${notices.join("；")}。`);
        continue;
      }
    }
    // Do not guess how to rewrite hand-edited inline references, or touch code examples.
    const dangling = [...prose(line.text).matchAll(/\](?:\(#([a-z0-9-]+)\)|\[([a-z0-9-]+)\])/gi)]
      .some(match => SOURCE_ID.test((match[1] ?? match[2])!));
    if (dangling) throw new LearnError("READING_FORMAT_UNSUPPORTED", "正文仍有自定义来源引用，未生成带悬空链接的阅读版；请先审核原稿。");
    output.push(line.text === "- 正文仅保留简短来源定位，完整原稿和材料仍在本机缓存。"
      ? "- 本版省略来源编号和时间定位；完整来源保留在带索引原稿及本机材料中。" : line.text);
  }
  return output.join("\n");
}

/** Derive a presentation only: no model, fetching, factual supplementation or publication. */
export function readingMarkdown(source: Draft, readingId: string): string {
  if (source.kind === "practice") throw new LearnError("READING_UNSUPPORTED", "无索引阅读版目前支持正文讲义、合并讲义和综合教程，学习辅助保持原有依据索引。");
  const markdown = source.markdown.replace(/^\uFEFF/, "");
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  const metadata = front ? front[1]!.split(/\r?\n/) : [];
  if (metadata.some(line => /^(?:title|draft_id|document_variant|source_draft_id|source_snapshot_sha256):\s*[>|]/.test(line))) {
    throw new LearnError("READING_FORMAT_UNSUPPORTED", "文档元数据使用了自定义多行格式，未自动改写；请先审核原稿。");
  }
  const body = stripIndexes(markdown.slice(front?.[0].length ?? 0));
  const title = cleanMarkdown(source.title).replace(/[\r\n#]/g, " ") + " · 无索引阅读版";
  const header = ["---", `title: ${JSON.stringify(title)}`, `draft_id: ${JSON.stringify(id(readingId))}`,
    ...metadata.filter(line => !/^(?:title|draft_id|document_variant|source_draft_id|source_snapshot_sha256):/.test(line)),
    'document_variant: "index-free-reading"', `source_draft_id: ${JSON.stringify(source.id)}`,
    `source_snapshot_sha256: ${JSON.stringify(hash(source.markdown))}`, "---", ""];
  let titled = false;
  const output = linesOf(body).flatMap(line => {
    if (!titled && line.outsideCode && /^# /.test(line.text)) {
      titled = true;
      return [line.text + " · 无索引阅读版", "", NOTICE];
    }
    return [line.text];
  });
  if (!titled) output.unshift(`# ${title}`, "", NOTICE, "");
  return validateReviewedMarkdown([...header, ...output].join("\n"));
}

/** A stable, separately reviewable draft; reuse its unfinished edits, never change the indexed source. */
export async function createReadingDraft(store: Store, sourceId: string, expectedHash: string): Promise<Draft> {
  const key = id(sourceId);
  return store.lock(`publish-${key}`, async () => {
    const source = await store.draft(key), plan = await store.activePlan();
    if (source.planId !== plan.id || source.planRevision !== plan.revision) throw new LearnError("PLAN_CHANGED", "阅读版来源不属于当前计划版本，请切回原计划后审核。");
    if (source.id !== key || hash(source.markdown) !== expectedHash) throw new LearnError("REVIEW_CONFLICT", "选择版本期间原稿已改变，请重新选择并审核。");
    if (source.readingVersion) return source;
    const sourceHash = hash(source.markdown), readingId = hash({ sourceDraftId: key, sourceHash, version: VERSION });
    return store.lock(`publish-${readingId}`, async () => {
      const existing = await store.read<Draft>("drafts", readingId);
      if (existing) {
        const saved = await store.draft(readingId);
        if (saved.id !== readingId || saved.planId !== plan.id || saved.planRevision !== plan.revision
          || saved.kind !== source.kind || saved.readingVersion?.sourceDraftId !== key || saved.readingVersion.sourceHash !== sourceHash) {
          throw new LearnError("READING_INVALID_CACHE", "阅读版缓存与来源快照不一致，未覆盖或发布。");
        }
        return saved;
      }
      const draft: Draft = { ...source, id: readingId, title: source.title + " · 无索引阅读版", markdown: readingMarkdown(source, readingId),
        readingVersion: { sourceDraftId: key, sourceHash }, createdAt: new Date().toISOString(), usage: emptyUsage(), publishedPaths: [] };
      await store.updateDraft(draft);
      return draft;
    });
  });
}
