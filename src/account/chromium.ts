import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { atomicText, defaultHome, ensureDirectory, readText } from "../files.ts";
import { LearnError } from "../types.ts";
import { CdpClient } from "./cdp.ts";
import type { BrowserKind, BrowserPreference, BrowserSession, ChromiumLaunchOptions } from "./types.ts";

const MARKER = ".nibblearn-bilibili-profile.json";
const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LABEL: Record<BrowserKind, string> = { edge: "Edge", chrome: "Chrome" };
const BILIBILI_HOME = "https://www.bilibili.com/";
const COOKIE_URLS = [BILIBILI_HOME, "https://api.bilibili.com/"];
interface Installation { browser: BrowserKind; executable: string }
interface Lease { token: string; ownerPid: number; browserPid?: number; browser?: BrowserKind }
interface ProfileLease { update(pid: number): Promise<void>; release(): Promise<void> }

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function preference(value: unknown): BrowserPreference {
  if (value === undefined) return "auto";
  if (typeof value !== "string" || !["auto", "edge", "chrome"].includes(value.trim().toLowerCase())) {
    throw new LearnError("BROWSER_SELECTION", "当前只支持 auto、edge 或 chrome；其他浏览器尚未适配。");
  }
  return value.trim().toLowerCase() as BrowserPreference;
}
function inferBrowser(executable: string): BrowserKind | undefined {
  const name = path.basename(executable).toLowerCase();
  if (["msedge.exe", "msedge", "microsoft-edge", "microsoft-edge-stable", "microsoft edge"].includes(name)) return "edge";
  if (["chrome.exe", "chrome", "google-chrome", "google-chrome-stable", "google chrome"].includes(name)) return "chrome";
  return undefined;
}
function candidates(browser: BrowserKind): string[] {
  if (process.platform === "win32") {
    const suffix = browser === "edge" ? ["Microsoft", "Edge", "Application", "msedge.exe"] : ["Google", "Chrome", "Application", "chrome.exe"];
    const system = process.env.ProgramFiles || "C:\\Program Files";
    const x86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [...(browser === "edge" ? [x86, system] : [system, x86]), ...(process.env.LOCALAPPDATA ? [process.env.LOCALAPPDATA] : [])]
      .map(root => path.join(root, ...suffix));
  }
  if (process.platform === "darwin") {
    const name = browser === "edge" ? "Microsoft Edge" : "Google Chrome";
    return [path.join("/Applications", `${name}.app`, "Contents", "MacOS", name), path.join(os.homedir(), "Applications", `${name}.app`, "Contents", "MacOS", name)];
  }
  return browser === "edge"
    ? ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/opt/google/chrome/google-chrome"];
}
async function executableExists(file: string): Promise<boolean> {
  try { await fs.access(file, constants.X_OK); return (await fs.stat(file)).isFile(); }
  catch { return false; }
}

/** Names only: no process is started and no browser profile is accessed. */
export async function availableBrowsers(): Promise<BrowserKind[]> {
  const available: BrowserKind[] = [];
  for (const browser of ["edge", "chrome"] as const) {
    const generic = process.env.NIBBLEARN_BROWSER_PATH;
    const legacy = browser === "edge" ? process.env.NIBBLEARN_EDGE_PATH : undefined;
    const configured = [
      ...(generic && path.isAbsolute(generic) && inferBrowser(generic) === browser ? [generic] : []),
      ...(legacy && path.isAbsolute(legacy) && inferBrowser(legacy) !== "chrome" ? [legacy] : []),
    ];
    for (const file of [...configured, ...candidates(browser)]) {
      if (await executableExists(file)) { available.push(browser); break; }
    }
  }
  return available;
}

async function resolveInstallation(options: ChromiumLaunchOptions): Promise<Installation> {
  const selected = preference(options.browser ?? (process.env.NIBBLEARN_BROWSER || undefined));
  const legacy = selected !== "chrome" ? process.env.NIBBLEARN_EDGE_PATH || undefined : undefined;
  const generic = process.env.NIBBLEARN_BROWSER_PATH || undefined;
  const configured = options.executablePath ?? generic ?? legacy;
  if (configured !== undefined) {
    if (!configured || !path.isAbsolute(configured)) throw new LearnError("BROWSER_PATH", "浏览器可执行文件必须使用非空的绝对路径。");
    const usingLegacy = options.executablePath === undefined && !generic && legacy !== undefined;
    const detected = inferBrowser(configured);
    if (usingLegacy && detected === "chrome") throw new LearnError("BROWSER_MISMATCH", "NIBBLEARN_EDGE_PATH 只能配置 Edge；Chrome 请使用通用浏览器配置。");
    const inferred = detected ?? (usingLegacy ? "edge" : undefined);
    if (selected !== "auto" && inferred && inferred !== selected) throw new LearnError("BROWSER_MISMATCH", "浏览器选择与程序路径不一致，已停止启动。");
    const browser = selected === "auto" ? inferred : selected;
    if (!browser) throw new LearnError("BROWSER_SELECTION", "无法从自定义路径判断浏览器类型，请明确指定 browser 为 edge 或 chrome。");
    if (!await executableExists(configured)) throw new LearnError("BROWSER_NOT_FOUND", "指定的浏览器程序不存在或不可执行；模块不会下载浏览器。");
    return { browser, executable: configured };
  }
  for (const browser of selected === "auto" ? ["edge", "chrome"] as const : [selected]) {
    for (const executable of candidates(browser)) if (await executableExists(executable)) return { browser, executable };
  }
  throw new LearnError("BROWSER_NOT_FOUND", `没有找到已安装的 ${selected === "auto" ? "Edge 或 Chrome" : LABEL[selected]}。可通过 executablePath 或 NIBBLEARN_BROWSER_PATH 指定；不会自动下载。`);
}

async function dedicatedProfile(directory: string, browser: BrowserKind): Promise<string> {
  if (!path.isAbsolute(directory)) throw new LearnError("BROWSER_PROFILE", "浏览器专用配置目录必须是绝对路径。");
  const requested = path.resolve(directory);
  if (within(SOURCE_ROOT, requested) || within(requested, SOURCE_ROOT)) throw new LearnError("BROWSER_PROFILE", "浏览器配置必须放在源码仓库之外，避免误上传登录数据。");
  const root = await ensureDirectory(requested);
  const source = await fs.realpath(SOURCE_ROOT);
  if (within(source, root) || within(root, source)) throw new LearnError("BROWSER_PROFILE", "浏览器配置不能与源码目录重叠。");
  const marker = path.join(root, MARKER);
  try {
    const value = JSON.parse(await readText(marker, 2000)) as { application?: unknown; version?: unknown; browser?: unknown };
    const legacyEdge = value.application === "nibblearn-bilibili-edge" && value.version === 1;
    const current = value.application === "nibblearn-bilibili-chromium" && value.version === 2 && ["edge", "chrome"].includes(String(value.browser));
    if (!legacyEdge && !current) throw new LearnError("BROWSER_PROFILE", "配置目录标记无效，已停止访问。");
    const owner = legacyEdge ? "edge" : value.browser;
    if (owner !== browser) throw new LearnError("BROWSER_PROFILE_MISMATCH", "该配置属于另一种浏览器。Edge 和 Chrome 必须分别登录，不能混用配置。");
    // Leave legacy Edge markers and existing login data unchanged.
  } catch (error) {
    if (error instanceof LearnError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new LearnError("BROWSER_PROFILE", "配置目录标记无法读取，已停止访问。");
    if ((await fs.readdir(root)).length !== 0) throw new LearnError("BROWSER_PROFILE", "只能使用新的空目录或 Nibblearn 专用配置，不能接管日常浏览器配置。");
    await fs.writeFile(marker, JSON.stringify({ application: "nibblearn-bilibili-chromium", version: 2, browser }) + "\n", { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.join(root, ".gitignore"), "*\n!.gitignore\n", { flag: "wx", mode: 0o600 });
  }
  return root;
}

async function claimProfile(directory: string, browser: BrowserKind): Promise<ProfileLease> {
  // Preserve the old Edge lock so old and new launchers cannot use its profile concurrently.
  const file = path.join(directory, browser === "edge" ? ".nibblearn-edge.lock" : ".nibblearn-chrome.lock");
  const lease: Lease = { token: randomUUID(), ownerPid: process.pid, browser };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(lease)); } finally { await handle.close(); }
      return {
        async update(pid) { lease.browserPid = pid; await atomicText(file, JSON.stringify(lease)); },
        async release() {
          try {
            const saved = JSON.parse(await readText(file, 2000)) as Lease;
            if (saved.token === lease.token) await fs.unlink(file);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new LearnError("BROWSER_PROFILE_LOCK", "无法释放专用浏览器的本地锁。"); }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let saved: Lease;
      try { saved = JSON.parse(await readText(file, 2000)) as Lease; }
      catch { throw new LearnError("BROWSER_PROFILE_LOCK", "专用浏览器锁文件损坏，请人工确认窗口已关闭后处理。"); }
      if (!saved || typeof saved.token !== "string" || !Number.isSafeInteger(saved.ownerPid) || saved.ownerPid < 1
        || (saved.browser !== undefined && saved.browser !== browser)
        || (saved.browserPid !== undefined && (!Number.isSafeInteger(saved.browserPid) || saved.browserPid < 1))) throw new LearnError("BROWSER_PROFILE_LOCK", "专用浏览器的锁文件无效。");
      if (alive(saved.ownerPid) || alive(saved.browserPid)) throw new LearnError("BROWSER_PROFILE_BUSY", "该专用配置正在使用，请先关闭所属会话；不会连接或终止日常浏览器。");
      if (attempt === 0) { await fs.unlink(file); continue; }
    }
  }
  throw new LearnError("BROWSER_PROFILE_BUSY", "专用浏览器配置已被其他操作占用。");
}

async function stopOwnedBrowser(child: ChildProcess, client?: CdpClient): Promise<void> {
  if (client?.isOpen) {
    try { await client.send("Browser.close", {}, undefined, AbortSignal.timeout(3000)); } catch { /* It may close before acknowledging. */ }
  }
  client?.close();
  for (let i = 0; i < 10 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    // Only the process created here. Never terminate browsers by executable name.
    try { child.kill(); } catch { /* It may already have exited. */ }
    for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  }
}

/** Shared Chromium adapter. The account manager does not need to know about CDP. */
export class ChromiumSession implements BrowserSession {
  readonly browser: BrowserKind;
  /** Internal transport; retained for compatibility with the old EdgeSession wrapper. */
  readonly client: CdpClient;
  private readonly child: ChildProcess;
  private readonly lease: ProfileLease;
  private sessionId?: string;
  private closePromise?: Promise<void>;

  private constructor(browser: BrowserKind, child: ChildProcess, client: CdpClient, lease: ProfileLease) {
    this.browser = browser; this.child = child; this.client = client; this.lease = lease;
  }

  static async launch(options: ChromiumLaunchOptions = {}): Promise<ChromiumSession> {
    options.signal?.throwIfAborted();
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new LearnError("BROWSER_TIMEOUT", "浏览器启动等待时间必须为有效正数。");
    const installation = await resolveInstallation(options);
    const home = path.resolve(options.homeDirectory ?? defaultHome());
    const directory = await dedicatedProfile(options.profileDirectory ?? path.join(home, `${installation.browser}-bilibili`), installation.browser);
    const lease = await claimProfile(directory, installation.browser);
    let child: ChildProcess | undefined, client: CdpClient | undefined;
    try {
      const portFile = path.join(directory, "DevToolsActivePort");
      await fs.rm(portFile, { force: true });
      const timeoutMs = Math.max(5000, Math.min(60000, options.timeoutMs ?? 20000));
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      child = spawn(installation.executable, [
        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        `--user-data-dir=${directory}`, "--no-first-run", "--no-default-browser-check", "--new-window", "about:blank",
      ], { shell: false, windowsHide: false, stdio: "ignore" });
      let failed = false;
      child.on("error", () => { failed = true; });
      if (child.pid) await lease.update(child.pid);
      while (!client) {
        signal.throwIfAborted();
        if (failed || child.exitCode !== null || child.signalCode !== null) throw new LearnError("BROWSER_LAUNCH", `${LABEL[installation.browser]} 未能启动专用窗口，或配置已被占用。`);
        let endpoint: string | undefined;
        try {
          const lines = (await readText(portFile, 2000)).trim().split(/\r?\n/);
          if (/^[0-9]+$/.test(lines[0] ?? "") && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(lines[1] ?? "")) endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new LearnError("BROWSER_ENDPOINT", "无法读取专用浏览器的本地连接信息。"); }
        if (endpoint) client = await CdpClient.connect(endpoint, signal);
        else await delay(100, undefined, { signal });
      }
      return new ChromiumSession(installation.browser, child, client, lease);
    } catch (error) {
      if (child) await stopOwnedBrowser(child, client);
      if (!child?.pid || !alive(child.pid)) await lease.release();
      if (options.signal?.aborted) throw new DOMException("操作已取消。", "AbortError");
      if (error instanceof LearnError) throw error;
      throw new LearnError("BROWSER_LAUNCH", "浏览器启动超时或失败，请检查安装位置和专用窗口状态。");
    }
  }

  get isOpen(): boolean { return this.client.isOpen && this.child.exitCode === null && this.child.signalCode === null; }

  async openLoginPage(signal?: AbortSignal): Promise<void> {
    const target = await this.client.send<{ targetId?: string }>("Target.createTarget", { url: BILIBILI_HOME, background: false }, undefined, signal);
    if (!target.targetId) throw new LearnError("BROWSER_PAGE", "无法打开 Bilibili 登录页。");
    const attached = await this.client.send<{ sessionId?: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true }, undefined, signal);
    if (!attached.sessionId) throw new LearnError("BROWSER_PAGE", "无法连接专用 Bilibili 标签页。");
    this.sessionId = attached.sessionId;
  }

  async readCookies(signal?: AbortSignal): Promise<unknown[]> {
    if (!this.isOpen || !this.sessionId) throw new LearnError("BROWSER_NOT_OPEN", "请先打开专用 Bilibili 登录页。");
    const response = await this.client.send<{ cookies?: unknown[] }>("Network.getCookies", { urls: COOKIE_URLS }, this.sessionId, signal);
    if (!Array.isArray(response.cookies) || response.cookies.length > 500) throw new LearnError("ACCOUNT_COOKIES", "无法读取专用配置的 Bilibili 会话。");
    return response.cookies;
  }

  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      await stopOwnedBrowser(this.child, this.client);
      if (!this.child.pid || !alive(this.child.pid)) await this.lease.release();
      else throw new LearnError("BROWSER_CLOSE", "专用浏览器尚未退出，请手动关闭该窗口；没有操作其他浏览器进程。");
    })();
  }
}
