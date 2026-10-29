export interface Reference {
  id: string;
  title: string;
  text: string;
}

export interface Plan {
  schemaVersion: 1;
  id: string;
  revision: number;
  title: string;
  topic: string;
  goal: string;
  background: string;
  focus: string;
  noteStyle: string;
  language: string;
  outputDir: string;
  allowModelSupplement: boolean;
  consentModelTransfer: boolean;
  references: Reference[];
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface VideoSource {
  bvid: string;
  cid: number;
  aid?: number;
  part: number;
  title: string;
  author: string;
  sourceUrl: string;
  duration?: number;
}
export interface CourseUnit extends VideoSource {
  /** Global course chapter index; part remains the actual P within this BV. */
  index?: number;
  videoIndex?: number;
  videoTitle?: string;
}
export interface CollectionInfo {
  id?: number;
  title: string;
  bvids?: string[];
  unavailable?: string;
}
export interface CourseListing {
  bvid: string;
  title: string;
  parts: CourseUnit[];
  collection?: CollectionInfo;
  videos?: { bvid: string; title: string; index: number; parts: number }[];
  origin?: "manual" | "season";
  /** Oldest metadata snapshot reused during multi-video enumeration, if any. */
  catalogCachedAt?: string;
}
export type CourseScope = { kind: "video"; current: CourseListing } | { kind: "manual"; bvids: string[] };
export const courseUnitIndex = (unit: CourseUnit): number => unit.index ?? unit.part;
export const courseUnitLabel = (unit: CourseUnit): string => unit.videoIndex === undefined ? `P${unit.part}` : `视频${unit.videoIndex} ${unit.bvid} / P${unit.part}`;
export interface CoursePartResult {
  /** Global chapter index; legacy single-BV records use the P number. */
  part: number;
  bvid?: string;
  sourcePart?: number;
  videoIndex?: number;
  cid: number;
  title: string;
  draftId: string;
  visual: boolean;
  reused: boolean;
}
export type CourseOutputMode = "separate" | "merged" | "tutorial";
export interface CourseJob {
  id: string;
  kind: "course";
  planId: string;
  planRevision: number;
  bvid: string;
  title: string;
  total: number;
  inputs?: string[];
  origin?: "manual" | "season";
  stoppedLabel?: string;
  status: "running" | "completed" | "stopped" | "cancelled";
  completed: CoursePartResult[];
  /** Missing on records created before output-mode selection was introduced. */
  outputMode?: CourseOutputMode;
  mergedDraftId?: string;
  mergeError?: string;
  tutorialDraftId?: string;
  tutorialJobId?: string;
  tutorialError?: string;
  stoppedPart?: number;
  error?: string;
  at: string;
}
export interface VisualAssets {
  /** Directory name under the private materials bucket, never an arbitrary path. */
  directory: string;
  frames: { time: number; sha256: string }[];
}

export interface Material {
  schemaVersion: 1;
  id: string;
  kind: "bilibili-subtitle" | "imported-subtitle" | "bilibili-visual";
  title: string;
  author: string;
  sourceUrl?: string;
  bvid?: string;
  aid?: number;
  cid?: number;
  part?: number;
  language: string;
  duration?: number;
  segments: Segment[];
  visual?: VisualAssets;
  warnings: string[];
  fetchedAt: string;
}

export interface TeachingExample {
  /** A source example, or an explicit deduction using only source-given conditions. */
  basis: "material" | "derivation";
  conditions: string;
  steps: string[];
  result: string;
  interpretation: string;
  evidence: number[];
}
export interface Point {
  heading: string;
  explanation: string;
  evidence: number[];
  examples?: TeachingExample[];
}
export interface Supplement {
  text: string;
  referenceIds: string[];
}
export interface Notes {
  overview: string;
  points: Point[];
  supplements: Supplement[];
  questions: string[];
  caveats: string[];
  checklist?: string[];
}

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface ModelRequest {
  system: string;
  prompt: string;
  /** Omit to use the host model's output limit, bounded by available context. */
  maxTokens?: number;
  images?: { data: string; mimeType: "image/jpeg" }[];
  signal?: AbortSignal;
}
export interface ModelResult {
  text: string;
  usage?: ModelUsage;
}
export type ModelRunner = ((request: ModelRequest) => Promise<ModelResult>) & {
  /** Visual generation requires an explicit capability declaration, not a text-only fallback. */
  supportsImages?: boolean;
  maxImagesPerRequest?: number;
};

interface DraftBase {
  schemaVersion: 1;
  id: string;
  planId: string;
  planRevision: number;
  title: string;
  markdown: string;
  createdAt: string;
  usage: ModelUsage;
  publishedPaths: string[];
  /** Local presentation variant; the indexed source snapshot remains untouched. */
  readingVersion?: { sourceDraftId: string; sourceHash: string };
}

export interface MaterialDraft extends DraftBase {
  /** Omitted on legacy single-material drafts. */
  kind?: "material";
  materialId: string;
}
export interface CourseDraft extends DraftBase {
  kind: "course";
  course: { jobId: string; bvid: string; total: number; parts: CoursePartResult[]; tutorial?: boolean };
}
export type PracticeMode = "questions" | "checklist" | "both";
export interface PracticeDraft extends DraftBase {
  kind: "practice";
  practice: { jobId: string; sourceDraftId: string; sourceHash: string; mode: PracticeMode };
}
export type Draft = MaterialDraft | CourseDraft | PracticeDraft;
export interface PracticeApproval {
  jobId: string;
  title: string;
  sourceDraftId: string;
  mode: PracticeMode;
  totalBatches: number;
  completedBatches: number;
  maxNewCalls: number;
  resuming: boolean;
  sourceCharacters: number;
}
export type ApprovePractice = (summary: PracticeApproval, signal?: AbortSignal) => Promise<boolean>;

export interface TutorialApproval {
  stage: "budget" | "outline";
  jobId: string;
  title: string;
  sourceParts: number;
  totalParts: number;
  units: number;
  visualSourceParts: number;
  excludedSupplementBlocks: number;
  maxNewCalls: number;
  completedChapters: number;
  resuming: boolean;
  chapters?: string[];
  omitted?: { count: number; reason: string }[];
}
export type ApproveTutorial = (summary: TutorialApproval, signal?: AbortSignal) => Promise<boolean>;

export interface Credentials {
  sessdata: string;
  bili_jct: string;
  buvid3: string;
}

export class LearnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LearnError";
    this.code = code;
  }
}
/** Numeric/closed-enum diagnostics only: never persist response bodies, headers or provider errors. */
export interface ModelRunDiagnostics {
  stopReason: "stop" | "length" | "error" | "toolUse" | "unknown" | "request_failed";
  maxTokens: number;
  modelMaxTokens: number;
  contextWindow: number;
  estimatedInputTokens: number;
}
export class ModelRunError extends LearnError {
  readonly usage?: ModelUsage;
  readonly diagnostics?: ModelRunDiagnostics;
  constructor(code: string, message: string, usage?: ModelUsage, diagnostics?: ModelRunDiagnostics) {
    super(code, message);
    this.usage = usage;
    this.diagnostics = diagnostics;
  }
}
export function publicError(error: unknown): string {
  if (error instanceof LearnError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "CANCELLED: 操作已取消或超时，未发布文件。";
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const fileErrors: Record<string, string> = {
    ENOENT: "找不到指定文件或目录，请检查输入路径。",
    EACCES: "当前系统用户没有文件读写权限。",
    EPERM: "系统拒绝文件操作，请检查权限或文件系统支持。",
    ENOSPC: "磁盘空间不足，未覆盖已有文件。",
    EISDIR: "指定路径是目录，请选择实际文件。",
  };
  if (code && fileErrors[code]) return `${code}: ${fileErrors[code]}`;
  // Never echo raw provider/HTTP errors: they can contain request headers or signed URLs.
  return "OPERATION_FAILED: 操作失败。请检查配置、文件权限或模型连接；未回显底层请求中的敏感信息。";
}
