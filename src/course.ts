import type { CourseJob, CourseListing, MaterialDraft, Plan } from "./types.ts";
import { courseUnitIndex, courseUnitLabel, LearnError } from "./types.ts";

export const COURSE_DOCUMENT_VERSION = "course-document-v3";
const titleText = (value: string) => value.replace(/[\x00-\x1f\x7f#]/g, " ").replace(/!\[/g, "\\![").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clean = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/g, "")
  .replace(/!\[/g, "\\![").replace(/<[^>]*>/g, match => match.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
const FOOTER = "由 Nibblearn 辅助整理。请核对原始材料；模型补充不等于已核验事实。";
type Section = "prefix" | "body" | "overview" | "scope" | "supplements" | "references" | "questions" | "caveats" | "evidence";
const SECTIONS = new Map<string, Section>([
  ["材料范围与限制", "scope"], ["学习导读", "overview"], ["采样学习导读", "overview"], ["内容概述", "overview"],
  ["学习正文", "body"], ["视频内容整理", "body"], ["采样画面整理（非完整视频总结）", "body"],
  ["补充说明（非视频原话）", "supplements"], ["用户提供的参考材料", "references"],
  ["自测与检查要点", "questions"], ["自测与后续行动", "questions"], ["待验证与注意事项", "caveats"],
  ["字幕来源索引", "evidence"], ["画面来源索引（不是台词）", "evidence"],
]);
interface Block { section: Section; lines: string[]; shift: number }
interface Chapter { part: number; label: string; sections: Record<Section, string[]> }

/** Only recognized template sections are relocated. Unknown headings and fenced code are preserved. */
function chapterSections(markdown: string, part: number, plan: Plan, author: string, namespace = `P${part}`, label = `P${part}`, bodyShift = 0): Chapter {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trimStart()
    .replace(/^# [^\r\n]*(?:\r?\n|$)/, "");
  const input = body.split(/\r?\n/);
  const blocks: Block[] = [{ section: "prefix", lines: [], shift: 1 }];
  let current = blocks[0]!;
  let fence: { character: string; length: number } | undefined;
  let recognized = false;
  for (let index = 0; index < input.length; index++) {
    const line = input[index]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      current.lines.push(line);
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (marker) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length };
      current.lines.push(line); continue;
    }
    // Remove exactly the generated footer, never arbitrary edits following it.
    if (line === "---" && input[index + 1] === FOOTER) { index++; continue; }
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      const section = SECTIONS.get(heading[1]!);
      if (section) {
        recognized = true;
        current = { section, lines: [], shift: section === "body" ? bodyShift : 1 };
      } else current = { section: "body", lines: [line], shift: 1 + bodyShift };
      blocks.push(current);
    } else current.lines.push(line);
  }
  if (fence) throw new LearnError("COURSE_MARKDOWN_INVALID", `${label} 草稿存在未闭合的代码块，可能吞掉后续章节；请先通过 /learn review 修正该分 P 草稿，再重新合并。`);
  const sections: Chapter["sections"] = { prefix: [], body: [], overview: [], scope: [], supplements: [], references: [], questions: [], caveats: [], evidence: [] };
  for (const block of blocks) {
    let value = block.lines.join("\n");
    if (block.section === "prefix" && recognized) {
      // Exact generated values only: edited metadata and unrelated text remain in source notes.
      const firstFence = block.lines.findIndex(line => /^ {0,3}(?:`{3,}|~{3,})/.test(line));
      let header = (firstFence < 0 ? block.lines : block.lines.slice(0, firstFence)).join("\n");
      for (const field of [`- 学习计划：${titleText(plan.title)}`, `- 学习目标：${clean(plan.goal)}`, `- 作者：${titleText(author)}`]) {
        header = `\n${header}\n`.replace(`\n${field}\n`, "\n").trim();
      }
      value = firstFence < 0 ? header : `${header}\n${block.lines.slice(firstFence).join("\n")}`;
    }
    value = transform(value, namespace, block.shift + (block.section === "prefix" && !recognized ? bodyShift : 0));
    if (!value || (block.section === "supplements" && value === "本次未添加补充资料。")) continue;
    sections[block.section === "prefix" && !recognized ? "body" : block.section].push(value);
  }
  return { part, label, sections };
}

function transform(value: string, namespace: string, shift: number): string {
  let fence: { character: string; length: number } | undefined;
  return value.split("\n").map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      return line;
    }
    if (marker) { fence = { character: marker[1]![0]!, length: marker[1]!.length }; return line; }
    const evidence = /^(#{1,6}) E([1-9][0-9]*)\s*$/.exec(line);
    if (evidence) return `${"#".repeat(Math.min(6, evidence[1]!.length + shift))} ${namespace}-E${evidence[2]}`;
    return line.replace(/\]\(#e([1-9][0-9]*)\)/g, `](#${namespace.toLowerCase()}-e$1)`)
      .replace(/^(#{1,6}) /, (_, marks: string) => `${"#".repeat(Math.min(6, marks.length + shift))} `);
  }).join("\n").trim();
}

/** Split generated top-level list items, preserving continuation lines and complete fenced examples. */
function listItems(value: string): string[] {
  const items: string[] = [];
  let current: string[] = [], fence: { character: string; length: number } | undefined;
  for (const line of value.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && /^- /.test(line) && current.some(item => item.trim())) {
      items.push(current.join("\n").trim()); current = [];
    }
    current.push(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    } else if (marker) fence = { character: marker[1]![0]!, length: marker[1]!.length };
  }
  if (current.some(item => item.trim())) items.push(current.join("\n").trim());
  return items;
}

/** Exact shared text only; never semantic deduplication of teaching content. */
function sharedSection(chapters: Chapter[], section: Section, heading: string): string[] {
  const groups = new Map<string, number[]>();
  for (const chapter of chapters) {
    const values = chapter.sections[section].flatMap(value => ["scope", "references", "caveats"].includes(section) ? listItems(value) : [value]);
    for (const value of values) {
      if (!value.trim()) continue;
      const parts = groups.get(value) ?? [];
      if (!parts.includes(chapter.part)) parts.push(chapter.part);
      groups.set(value, parts);
    }
  }
  if (!groups.size) return [];
  const byParts = new Map<string, string[]>();
  for (const [value, parts] of groups) {
    const label = parts.map(part => chapters.find(chapter => chapter.part === part)!.label).join("、");
    const values = byParts.get(label) ?? [];
    values.push(value); byParts.set(label, values);
  }
  return [`## ${heading}`, "", ...[...byParts].flatMap(([label, values]) => [
    `### 对应章节：${label}`, "", values.join("\n\n"), "",
  ])];
}

/** Local chapter assembly with one set of course-level sections, no model calls. */
export function renderCourseMarkdown(plan: Plan, original: CourseListing, job: CourseJob, drafts: MaterialDraft[], draftId: string): string {
  const multi = original.origin !== undefined;
  const namespaces = new Map(original.parts.map(p => [courseUnitIndex(p), multi ? `V${p.videoIndex}-P${p.part}` : `P${p.part}`]));
  const labels = new Map(original.parts.map(p => [courseUnitIndex(p), courseUnitLabel(p)]));
  const listing = { ...original, parts: original.parts.map(p => ({ ...p, part: courseUnitIndex(p) })) };
  const available = new Map(job.completed.map((part, index) => [part.part, { part, draft: drafts[index]! }]));
  const missing = listing.parts.filter(part => !available.has(part.part));
  const chapters = listing.parts.filter(p => available.has(p.part)).map(p => chapterSections(available.get(p.part)!.draft.markdown, p.part, plan, p.author, namespaces.get(p.part), labels.get(p.part), multi ? 1 : 0));
  const byPart = new Map(chapters.map(chapter => [chapter.part, chapter]));
  const authors = [...new Set(listing.parts.map(p => p.author))].map(titleText).join("、");
  const lines = ["---", `title: ${JSON.stringify(`${listing.title} · 合并讲义`)}`, `draft_id: ${JSON.stringify(draftId)}`,
    `plan_id: ${JSON.stringify(plan.id)}`, `plan_revision: ${plan.revision}`, 'source_kind: "bilibili-course"',
    `bvid: ${JSON.stringify(listing.bvid)}`, ...(multi ? [`source_bvids: ${JSON.stringify(listing.videos!.map(v => v.bvid))}`] : []), `parts_included: ${job.completed.length}`, `parts_total: ${listing.parts.length}`, "---", "",
    `# ${titleText(listing.title)} · 合并讲义`, "", `- 学习计划：${titleText(plan.title)}`, `- 学习目标：${titleText(plan.goal)}`, `- 作者：${authors}`,
    `- ${multi ? `课程包含 ${listing.videos!.length} 个独立视频；` : ""}收录 ${job.completed.length}/${listing.parts.length} 个分 P；${missing.length ? "这是部分讲义，不代表完整课程。" : "已收录所确认列表的全部分 P 草稿，但不代表完整观看或内容已核验。"}`,
    ...(missing.length ? [`- 未收录：${missing.map(p => labels.get(p.part)).join("、")}。请补齐后重新合并；已有部分稿不会被覆盖。`] : []), "",
    "## 目录", "", ...listing.parts.map(p => `- [${labels.get(p.part)}](#${namespaces.get(p.part)!.toLowerCase()})：${titleText(p.title)}${available.has(p.part) ? (available.get(p.part)!.part.visual ? "（仅采样画面，无声音）" : "（字幕讲义）") : "（未收录）"}`), "",
    ...sharedSection(chapters, "overview", "课程导读")];
  let videoIndex = 0;
  for (const source of listing.parts) {
    if (multi && source.videoIndex !== videoIndex) {
      videoIndex = source.videoIndex!;
      lines.push(`## 视频${videoIndex}`, "", `${titleText(source.videoTitle!)}（${source.bvid}）`, "");
    }
    lines.push(`${multi ? "###" : "##"} ${namespaces.get(source.part)}`, "", titleText(source.title), "");
    const chapter = available.get(source.part);
    if (!chapter) { lines.push("本 P 尚未收录，不能据此推断其内容。", ""); continue; }
    if (chapter.part.visual) lines.push("> 本章仅依据采样画面；无声音，不是完整台词或完整教程。", "");
    const content = byPart.get(source.part)!.sections.body;
    lines.push(content.length ? content.join("\n\n") : "本 P 未提供可用的知识正文，请查阅材料限制与来源说明。", "");
  }
  lines.push(...sharedSection(chapters, "supplements", "补充说明（非视频原话）"),
    ...sharedSection(chapters, "references", "用户提供的参考材料"),
    ...sharedSection(chapters, "questions", "自测与检查要点"),
    ...sharedSection(chapters, "scope", "材料范围与限制"),
    ...sharedSection(chapters, "caveats", "待验证与注意事项"),
    "## 来源索引", "");
  for (const source of listing.parts) {
    const chapter = available.get(source.part);
    if (!chapter) continue;
    const content = byPart.get(source.part)!;
    lines.push(`### 来源 · ${labels.get(source.part)}`, "", `- 原始草稿：${chapter.draft.id}`,
      `- 证据类型：${chapter.part.visual ? "采样画面；无声音，不是完整台词" : "字幕；不等同于完整观看或独立核验"}`, "",
      ...content.sections.prefix.flatMap(value => [value, ""]), ...content.sections.evidence.flatMap(value => [value, ""]));
  }
  lines.push("## 编排说明", "", "按视频及 P 顺序在本机编排，未增加模型请求；仅合并模板结构与完全相同的公共说明，未进行知识内容的跨 P 语义去重、推理或综合。",
    "各章原始草稿保留供复用；合并稿用量记录为各章历史生成用量合计，不是合并产生的新费用。", "", "---", FOOTER, "");
  return lines.join("\n");
}
