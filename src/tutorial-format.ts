import { timestamp } from "./notes.ts";

export interface SourceRange { start: number; end: number }
const PREVIEW_LOCATIONS = 3;
const rangeLabel = (range: SourceRange) => range.start === range.end ? timestamp(range.start) : `${timestamp(range.start)}–${timestamp(range.end)}`;

/**
 * Render validated locations without repeating thousands of full URLs. The complete
 * discrete list stays in the reviewable Markdown and the existing task manifest.
 * Never merge intervals across gaps or turn sampled instants into continuous viewing.
 */
export function renderSourceLocations(ranges: readonly SourceRange[], url: string | undefined, visual: boolean): string[] {
  const locations = [...new Map(ranges.map(range => [`${range.start}:${range.end}`, range])).values()]
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!locations.length || !url) return ["无直接视频定位；此项不是视频原话证据，需对照原稿或用户提供的材料。", ""];
  const kind = visual ? "采样时刻（无声音，不代表连续观看）" : "字幕定位";
  const links = locations.slice(0, PREVIEW_LOCATIONS).map(range => `[${rangeLabel(range)}](${url}&t=${range.start})`).join("、");
  if (locations.length <= PREVIEW_LOCATIONS) return [`${kind}：${links}`, ""];
  return [
    `${kind} · 回看入口（前 ${PREVIEW_LOCATIONS}/${locations.length} 处）：${links}`, "",
    // Only program-owned markup and validated numeric timestamps go in this disclosure.
    "<details>", `<summary>完整离散定位（${locations.length} 处）</summary>`, "",
    locations.map(rangeLabel).join("、"), "", "</details>", "",
  ];
}

/** Remove only an exact positional outline prefix; preserve years, decimals and technical names. */
export function tutorialSectionTitle(title: string, section: number): string {
  const prefix = new RegExp(`^\\s*(?:${section}[.、．)）]|[（(]${section}[）)])\\s+`);
  const stripped = title.replace(prefix, "").trim();
  return stripped || title.trim();
}
