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

export interface Material {
  schemaVersion: 1;
  id: string;
  kind: "bilibili-subtitle" | "imported-subtitle";
  title: string;
  author: string;
  sourceUrl?: string;
  bvid?: string;
  cid?: number;
  part?: number;
  language: string;
  duration?: number;
  segments: Segment[];
  warnings: string[];
  fetchedAt: string;
}

export interface Point {
  heading: string;
  explanation: string;
  evidence: number[];
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
  maxTokens: number;
  signal?: AbortSignal;
}
export interface ModelResult {
  text: string;
  usage?: ModelUsage;
}
export type ModelRunner = (request: ModelRequest) => Promise<ModelResult>;

export interface Draft {
  schemaVersion: 1;
  id: string;
  planId: string;
  planRevision: number;
  materialId: string;
  title: string;
  markdown: string;
  createdAt: string;
  usage: ModelUsage;
  publishedPaths: string[];
}

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
export class ModelRunError extends LearnError {
  readonly usage?: ModelUsage;
  constructor(code: string, message: string, usage?: ModelUsage) {
    super(code, message);
    this.usage = usage;
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
