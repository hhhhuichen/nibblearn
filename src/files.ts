import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { LearnError } from "./types.ts";

export function expandPath(input: string, cwd: string): string {
  const value = input.trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
  if (!value) throw new LearnError("INVALID_PATH", "请指定文件或目录。");
  return path.resolve(cwd, value === "~" ? os.homedir() : value.startsWith("~/") || value.startsWith("~\\") ? path.join(os.homedir(), value.slice(2)) : value);
}
export function defaultHome(): string {
  // Keep the original Pi data directory and env alias; never silently migrate user data.
  return process.env.NIBBLEARN_HOME || process.env.PI_LEARN_HOME || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "video-learn");
}
export async function ensureDirectory(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LearnError("UNSAFE_PATH", "目录不能是文件、符号链接或目录联接。");
  return fs.realpath(directory);
}
export async function safeChildDirectory(root: string, name: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new LearnError("UNSAFE_PATH", "不安全的子目录名称。");
  await assertDirectory(root);
  const child = path.join(root, name);
  try { await fs.mkdir(child, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  await assertDirectory(child);
  const real = await fs.realpath(child);
  if (path.dirname(real) !== await fs.realpath(root)) throw new LearnError("UNSAFE_PATH", "子目录超出了授权范围。");
  return real;
}
export async function assertDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LearnError("UNSAFE_PATH", "目标目录已变成链接或非目录，已停止写入。");
  // Detect a replaced ancestor directory as well as a symlink at the leaf.
  if (path.resolve(await fs.realpath(directory)) !== path.resolve(directory)) throw new LearnError("UNSAFE_PATH", "目录的真实路径已变化，请重新确认保存位置。");
}
export async function readText(file: string, limit = 8 * 1024 * 1024): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new LearnError("INVALID_FILE", `只支持普通文件，大小不能超过 ${limit} 字节。`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > limit) throw new LearnError("INVALID_FILE", "读取期间文件超过大小上限。");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await handle.close(); }
}
export async function atomicText(file: string, content: string): Promise<void> {
  await assertDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
export async function withFileLock<T>(directory: string, name: string, action: () => Promise<T>): Promise<T> {
  await assertDirectory(directory);
  const file = path.join(directory, `${name}.lock`);
  let handle;
  try { handle = await fs.open(file, "wx", 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let saved: { pid?: number } = {};
    try { saved = JSON.parse(await readText(file, 1000)); } catch { /* Corrupt locks fail closed. */ }
    if (saved.pid && Number.isSafeInteger(saved.pid)) {
      try { process.kill(saved.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          await fs.unlink(file);
          return withFileLock(directory, name, action);
        }
      }
    }
    throw new LearnError("BUSY", "相同任务正在执行，或上次锁状态需要人工检查；不会重复提交模型请求。");
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return await action();
  } finally { await handle.close(); await fs.unlink(file); }
}

export function safeFilename(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "-").replace(/[. ]+$/g, "").slice(0, 70).replace(/[. ]+$/g, "");
  return !cleaned || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(cleaned) ? "note" : cleaned;
}

/** No-clobber publication: atomic hard link when supported, exclusive copy otherwise. */
export async function publishMarkdown(root: string, planId: string, title: string, draftId: string, markdown: string): Promise<string> {
  await assertDirectory(root);
  const directory = await safeChildDirectory(root, planId);
  const base = `${safeFilename(title)}--${draftId.slice(0, 12)}`;
  const temporary = path.join(directory, `.nibblearn-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, markdown, { flag: "wx", mode: 0o600 });
    for (let version = 1; version <= 100; version++) {
      await assertDirectory(root);
      await assertDirectory(directory);
      const destination = path.join(directory, `${base}${version === 1 ? "" : `--v${version}`}.md`);
      try {
        try { await fs.link(temporary, destination); }
        catch (error) {
          if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          // COPYFILE_EXCL supports filesystems without hard links and never overwrites a target.
          await fs.copyFile(temporary, destination, constants.COPYFILE_EXCL);
        }
        return destination;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const stat = await fs.lstat(destination);
        if (stat.isFile() && !stat.isSymbolicLink() && await readText(destination) === markdown) return destination;
      }
    }
    throw new LearnError("NAME_CONFLICT", "同名版本过多，请更换输出目录或文件名。");
  } finally { await fs.rm(temporary, { force: true }); }
}
