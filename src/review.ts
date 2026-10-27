import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { assertDirectory, atomicText, safeChildDirectory } from "./files.ts";
import { hash, id, object, parseJson } from "./validate.ts";
import { LearnError } from "./types.ts";
import type { Draft } from "./types.ts";
import type { Store } from "./store.ts";

interface ReviewRecord {
  schemaVersion: 1; draftId: string; planId: string; planRevision: number; baseHash: string; fileName: string;
}
export interface ReviewFile extends ReviewRecord { filePath: string }
const FILE_NAME = /^review-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.md$/;

/** Only regular private review files. Refuse links, overlarge files, partial writes and non-UTF-8 text. */
async function readPrivateFile(file: string, limit: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await assertDirectory(path.dirname(file));
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit
    || path.resolve(await fs.realpath(file)) !== path.resolve(file)) {
    throw new LearnError("INVALID_REVIEW_FILE", "审核文件必须是大小合规的普通文件，不能是符号链接或硬链接。");
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > limit) {
      throw new LearnError("REVIEW_FILE_CHANGED", "审核文件在读取前已变化，请保存完毕后重新确认。");
    }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > limit) throw new LearnError("INVALID_REVIEW_FILE", "审核文件在读取期间超出大小限制。");
      chunks.push(chunk);
    }
    const after = await fs.lstat(file), final = await handle.stat();
    if (after.isSymbolicLink() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino
      || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs
      || after.size !== final.size || after.mtimeMs !== final.mtimeMs || size !== final.size) {
      throw new LearnError("REVIEW_FILE_CHANGED", "审核文件仍在编辑或保存中，请完成保存后再读取。");
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new LearnError("INVALID_REVIEW_ENCODING", "审核文件不是有效 UTF-8，请在外部编辑器中另存为 UTF-8 后再试。"); }
  } finally { await handle.close(); }
}
function validateRecord(value: unknown, draftId: string): ReviewRecord {
  const r = object(value);
  if (r.schemaVersion !== 1 || r.draftId !== draftId || typeof r.planId !== "string" || !Number.isSafeInteger(r.planRevision)
    || Number(r.planRevision) < 1 || typeof r.baseHash !== "string" || !/^[a-f0-9]{64}$/.test(r.baseHash)
    || typeof r.fileName !== "string" || !FILE_NAME.test(r.fileName)) {
    throw new LearnError("INVALID_REVIEW_FILE", "审核副本记录无效，未读取任意路径或覆盖已有文件。");
  }
  return { schemaVersion: 1, draftId, planId: id(r.planId), planRevision: Number(r.planRevision), baseHash: r.baseHash, fileName: r.fileName };
}
async function reviewDirectory(store: Store, draftId: string): Promise<string> {
  return safeChildDirectory(await store.directory("reviews"), hash(id(draftId)));
}
export function validateReviewedMarkdown(markdown: string): string {
  if (!markdown.trim() || markdown.length > 2_000_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(markdown)) {
    throw new LearnError("INVALID_DRAFT", "审核正文为空、包含控制字符或超过 2,000,000 字符；未发布。");
  }
  return markdown;
}
export async function readReviewFile(store: Store, review: ReviewFile, signal?: AbortSignal): Promise<string> {
  const record = validateRecord(review, id(review.draftId));
  const file = path.join(await reviewDirectory(store, record.draftId), record.fileName);
  // Never trust an arbitrary filePath supplied by a caller or a modified manifest.
  if (file !== review.filePath) throw new LearnError("INVALID_REVIEW_FILE", "审核路径与本机副本不匹配。");
  return validateReviewedMarkdown(await readPrivateFile(file, 8 * 1024 * 1024, signal));
}

/** Reuse unfinished edits; explicit fresh copies retain old files instead of overwriting them. */
export async function prepareReviewFile(store: Store, draft: Draft, fresh = false): Promise<ReviewFile> {
  return store.lock(`publish-${draft.id}`, async () => {
    const current = await store.draft(draft.id), plan = await store.activePlan();
    if (current.planId !== plan.id || current.planRevision !== plan.revision || current.planId !== draft.planId || current.planRevision !== draft.planRevision) {
      throw new LearnError("PLAN_CHANGED", "当前计划与待审核草稿不一致。");
    }
    if (hash(current.markdown) !== hash(draft.markdown)) throw new LearnError("REVIEW_CONFLICT", "草稿已被另一个操作修改，请重新选择并审核。");
    const directory = await reviewDirectory(store, draft.id), manifest = path.join(directory, "review.json");
    const baseHash = hash(draft.markdown);
    if (!fresh) {
      let previous: ReviewRecord | undefined;
      try { previous = validateRecord(parseJson(await readPrivateFile(manifest, 16000)), draft.id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (previous) {
        const review = { ...previous, filePath: path.join(directory, previous.fileName) };
        try { await fs.lstat(review.filePath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LearnError("REVIEW_STALE", `旧审核副本已被移动或删除：${review.filePath}`);
          throw error;
        }
        if (previous.planId !== plan.id || previous.planRevision !== plan.revision) {
          throw new LearnError("REVIEW_STALE", `旧审核副本属于不同计划版本，未覆盖：${review.filePath}`);
        }
        if (previous.baseHash !== baseHash) {
          // A prior review may have imported these exact edits before publication was cancelled.
          if (hash(await readReviewFile(store, review)) !== baseHash) throw new LearnError("REVIEW_STALE", `正文与旧审核副本已分叉，未覆盖：${review.filePath}`);
          review.baseHash = baseHash;
          const { filePath: _path, ...record } = review;
          await atomicText(manifest, JSON.stringify(record) + "\n");
        }
        return review;
      }
    }
    const record: ReviewRecord = { schemaVersion: 1, draftId: draft.id, planId: plan.id, planRevision: plan.revision,
      baseHash, fileName: `review-${randomUUID()}.md` };
    const filePath = path.join(directory, record.fileName);
    await fs.writeFile(filePath, validateReviewedMarkdown(draft.markdown), { flag: "wx", mode: 0o600 });
    await atomicText(manifest, JSON.stringify(record) + "\n");
    return { ...record, filePath };
  });
}

/** Advance the edit base after an explicit import, without rewriting the external file. */
export async function acknowledgeReviewFile(store: Store, review: ReviewFile, markdownHash: string): Promise<void> {
  await store.lock(`publish-${review.draftId}`, async () => {
    const directory = await reviewDirectory(store, review.draftId), manifest = path.join(directory, "review.json");
    const record = validateRecord(parseJson(await readPrivateFile(manifest, 16000)), review.draftId);
    const draft = await store.draft(review.draftId);
    if (record.fileName !== review.fileName || record.baseHash !== review.baseHash || hash(draft.markdown) !== markdownHash) {
      throw new LearnError("REVIEW_CONFLICT", "审核副本或草稿已被其他操作修改；已读入的编辑保留，但未发布，请重新审核。");
    }
    await atomicText(manifest, JSON.stringify({ ...record, baseHash: markdownHash }) + "\n");
    review.baseHash = markdownHash;
  });
}

/** Paths are arguments/environment data, never interpolated into shell commands. */
export function reviewOpenCommand(file: string, platform: NodeJS.Platform = process.platform): { executable: string; args: string[]; env?: NodeJS.ProcessEnv } {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".md") throw new LearnError("INVALID_REVIEW_FILE", "只能打开绝对路径的 Markdown 审核文件。");
  if (platform === "win32") return {
    executable: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:NIBBLEARN_REVIEW_FILE -ErrorAction Stop"],
    env: { ...process.env, NIBBLEARN_REVIEW_FILE: file },
  };
  if (platform === "darwin") return { executable: "/usr/bin/open", args: ["--", file] };
  if (platform === "linux") return { executable: "xdg-open", args: [file] };
  throw new LearnError("REVIEW_OPEN_UNSUPPORTED", "此系统没有内置打开方式，请使用显示的路径手动打开。");
}
export async function openReviewFile(store: Store, review: ReviewFile, signal?: AbortSignal): Promise<void> {
  await readReviewFile(store, review, signal);
  const command = reviewOpenCommand(review.filePath);
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(15000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.executable, command.args, { shell: false, windowsHide: true, stdio: "ignore", env: command.env, signal: combined });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("Open failed")));
    });
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new LearnError("REVIEW_OPEN_FAILED", "无法确认默认应用已打开审核文件；可能没有 Markdown 文件关联或图形桌面。请按显示的路径手动打开，草稿未发布。");
  }
}
