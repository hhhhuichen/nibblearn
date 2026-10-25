import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTrafficGuard } from "../../vendor/dsh-bili-whale/traffic.mjs";
import { credentialHeaders } from "../bilibili.ts";
import { assertDirectory, defaultHome, ensureDirectory } from "../files.ts";
import { LearnError } from "../types.ts";
import type { Credentials } from "../types.ts";
import { hash, object, validateCredentials } from "../validate.ts";
import { ChromiumSession } from "./chromium.ts";
import { abortable } from "./types.ts";
import type { AccountOperationOptions, AccountStatus, ApproveAccount, AuthorizationResult, BilibiliAccountOptions, BilibiliIdentity, BrowserKind, BrowserSession, WaitForLoginOptions } from "./types.ts";

export { availableBrowsers } from "./chromium.ts";
export type { AccountOperationOptions, AccountStatus, ApproveAccount, AuthorizationResult, BilibiliAccountOptions, BilibiliIdentity, BrowserKind, BrowserPreference, BrowserSession, ChromiumLaunchOptions, CredentialWriter, WaitForLoginOptions } from "./types.ts";

const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const COOKIE_DOMAINS = new Set(["bilibili.com", ".bilibili.com", "www.bilibili.com", ".www.bilibili.com", "api.bilibili.com", ".api.bilibili.com"]);
const CACHE_MS = 15000;
interface AuthenticatedSession { credentials: Credentials; account: BilibiliIdentity }

/**
 * Installed Edge/Chrome + browser-specific Bilibili profiles. No Pi registration or background work.
 *
 * Host integration, after the user authorizes that separate change:
 *   const account = new BilibiliAccount({ browser: "auto", credentialStore: existingStore });
 *   await account.openLogin();                 // Human logs in in the visible browser window.
 *   await account.waitForLogin();
 *   await account.authorizeAndSave(showUserConfirmation);
 *   await account.close();                    // Closes only its dedicated browser; login persists.
 *
 * Public results contain identity/status only. Credentials go directly to the trusted writer.
 */
export class BilibiliAccount {
  private readonly options: BilibiliAccountOptions;
  private readonly lifetime = new AbortController();
  private browser?: BrowserSession;
  private cached?: { key: string; at: number; status: AccountStatus };
  private guardInstance?: ReturnType<typeof createTrafficGuard>;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private closePromise?: Promise<void>;

  constructor(options: BilibiliAccountOptions = {}) { this.options = { ...options }; }

  private signal(options?: AccountOperationOptions): AbortSignal {
    if (this.disposed) throw new LearnError("ACCOUNT_CLOSED", "账号模块已关闭，请创建新的实例后连接。");
    return options?.signal ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private connected(): BrowserSession {
    if (!this.browser?.isOpen) throw new LearnError("BROWSER_NOT_OPEN", "请先打开 Nibblearn 的专用浏览器登录窗口。");
    return this.browser;
  }
  private home(): string { return path.resolve(this.options.homeDirectory ?? defaultHome()); }

  /** The selected browser name only, never an executable path or debug endpoint. */
  getBrowserKind(): BrowserKind | undefined { return this.browser?.isOpen ? this.browser.browser : undefined; }

  /** Auto prefers Edge, then Chrome; neither a browser nor a daily-use profile is imported. */
  async openLogin(options?: AccountOperationOptions): Promise<void> {
    const signal = this.signal(options);
    await this.serial(async () => {
      signal.throwIfAborted();
      const legacy = this.options.edgePath;
      if (legacy !== undefined && (this.options.executablePath !== undefined || (this.options.browser !== undefined && !["auto", "edge"].includes(this.options.browser)))) {
        throw new LearnError("BROWSER_CONFIG", "edgePath 仅兼容旧 Edge 配置，不能与 Chrome 或 executablePath 混用。");
      }
      if (!this.browser?.isOpen) {
        if (this.browser) await this.browser.close();
        this.browser = await ChromiumSession.launch({
          browser: legacy !== undefined ? "edge" : this.options.browser,
          executablePath: legacy ?? this.options.executablePath,
          homeDirectory: this.home(), profileDirectory: this.options.profileDirectory,
          timeoutMs: this.options.launchTimeoutMs, signal,
        });
      }
      try {
        await this.browser.openLoginPage(signal);
        this.cached = undefined;
      } catch (error) {
        await this.browser.close(); this.browser = undefined;
        throw error;
      }
    });
  }

  private async cookies(signal: AbortSignal): Promise<Credentials | undefined> {
    const cookies = await this.connected().readCookies(signal);
    if (!Array.isArray(cookies) || cookies.length > 500) throw new LearnError("ACCOUNT_COOKIES", "无法读取专用配置的 Bilibili 会话。");
    const values = new Map<string, string>();
    for (const entry of cookies) {
      const cookie = object(entry);
      const name = String(cookie.name ?? "");
      if (!["SESSDATA", "bili_jct", "buvid3"].includes(name) || !COOKIE_DOMAINS.has(String(cookie.domain ?? ""))) continue;
      if (typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires * 1000 <= Date.now()) continue;
      if (typeof cookie.value !== "string" || !cookie.value) continue;
      if (values.has(name) && values.get(name) !== cookie.value) throw new LearnError("ACCOUNT_COOKIES", "发现冲突的 Bilibili 会话，请在专用窗口重新登录。");
      values.set(name, cookie.value);
    }
    if (!values.has("SESSDATA")) return undefined;
    return validateCredentials({ sessdata: values.get("SESSDATA"), bili_jct: values.get("bili_jct") ?? "", buvid3: values.get("buvid3") ?? "" });
  }

  private async guard() {
    if (!this.guardInstance) {
      const directory = await ensureDirectory(path.join(this.home(), "traffic"));
      await assertDirectory(directory);
      this.guardInstance = createTrafficGuard({
        directory,
        transport: async (input, options = {}) => {
          const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
          if (url !== NAV_URL || String(options.method ?? "GET").toUpperCase() !== "GET") throw new LearnError("ACCOUNT_REQUEST", "账号模块只允许读取登录状态接口。");
          return globalThis.fetch(NAV_URL, { ...options, method: "GET", redirect: "error" });
        },
      });
    }
    return this.guardInstance;
  }

  private async identity(credentials: Credentials, signal: AbortSignal): Promise<BilibiliIdentity | undefined> {
    let response: Response;
    try { response = await (await this.guard()).fetch(NAV_URL, { method: "GET", headers: credentialHeaders(credentials), signal }); }
    catch (error) {
      if (signal.aborted) throw new DOMException("操作已取消。", "AbortError");
      if ((error as { code?: string }).code === "BILI_TRAFFIC_PAUSED") throw new LearnError("ACCOUNT_PAUSED", "请求已暂停。限流请等待；登录或验证码需人工处理后明确恢复。");
      if (error instanceof LearnError) throw error;
      throw new LearnError("ACCOUNT_NETWORK", "无法验证 Bilibili 登录态，请检查网络；未回显 Cookie 或请求详情。");
    }
    if ([412, 429].includes(response.status)) throw new LearnError("ACCOUNT_RATE_LIMITED", "平台要求暂停访问，已保留退避时间，不会自动连续重试。");
    if (response.status === 401) return undefined;
    if (!response.ok || !response.body) throw new LearnError("ACCOUNT_RESPONSE", "平台没有返回可用的登录状态。");
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > 256 * 1024) throw new LearnError("ACCOUNT_RESPONSE", "登录状态响应异常，已停止读取。");
        chunks.push(chunk);
      }
    } catch (error) {
      if (signal.aborted) throw new DOMException("操作已取消。", "AbortError");
      if (error instanceof LearnError) throw error;
      throw new LearnError("ACCOUNT_NETWORK", "读取登录状态失败。");
    }
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw new LearnError("ACCOUNT_RESPONSE", "登录接口没有返回有效 JSON，不能据此确认已登录。"); }
    const code = Number(body.code);
    if (code === -101) return undefined;
    if ([-412, -352, -799, -509, -10403].includes(code)) throw new LearnError("ACCOUNT_RATE_LIMITED", "Bilibili 限制访问，已暂停请求。");
    if ([12015, -105].includes(code)) throw new LearnError("ACCOUNT_VERIFICATION", "请在专用浏览器窗口人工处理验证码，然后明确恢复验证。");
    if (code !== 0) throw new LearnError("ACCOUNT_RESPONSE", "Bilibili 未确认登录状态，请在浏览器检查账号。");
    const data = object(body.data);
    if (data.isLogin === false) return undefined;
    const uid = data.mid;
    const validUid = (typeof uid === "string" && /^[1-9][0-9]{0,24}$/.test(uid)) || (typeof uid === "number" && Number.isSafeInteger(uid) && uid > 0);
    if (data.isLogin !== true || !validUid || typeof data.uname !== "string" || !data.uname.trim() || data.uname.length > 200 || /[\x00-\x1f\x7f]/.test(data.uname)) {
      throw new LearnError("ACCOUNT_RESPONSE", "平台账号信息不完整，不能确认当前身份。");
    }
    return { uid: String(uid), name: data.uname };
  }

  /** Status checks do not expose or persist credentials. Repeated checks share a short cache. */
  async getStatus(options?: AccountOperationOptions): Promise<AccountStatus> {
    const signal = this.signal(options);
    return this.serial(async () => {
      signal.throwIfAborted();
      if (!this.browser?.isOpen) { this.cached = undefined; return { state: "not-open" }; }
      const credentials = await this.cookies(signal);
      if (!credentials) { this.cached = undefined; return { state: "login-required" }; }
      const key = hash(credentials.sessdata);
      let status: AccountStatus;
      if (this.cached?.key === key && Date.now() - this.cached.at < CACHE_MS) status = this.cached.status;
      else {
        const account = await this.identity(credentials, signal);
        status = account ? { state: "logged-in", account } : { state: "login-required" };
        this.cached = { key, at: Date.now(), status };
      }
      return status.state === "logged-in" ? { state: "logged-in", account: { ...status.account } } : { ...status };
    });
  }

  /** Bounded foreground wait. QR login, credentials and CAPTCHA are always handled by the human. */
  async waitForLogin(options: WaitForLoginOptions = {}): Promise<BilibiliIdentity> {
    const timeout = options.timeoutMs ?? 180000;
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 600000) throw new LearnError("ACCOUNT_TIMEOUT", "登录等待时间必须在 1 秒至 10 分钟之间。");
    const parent = this.signal(options);
    const signal = AbortSignal.any([parent, AbortSignal.timeout(timeout)]);
    try {
      while (true) {
        const status = await this.getStatus({ signal });
        if (status.state === "logged-in") return status.account;
        if (status.state === "not-open") throw new LearnError("BROWSER_NOT_OPEN", "专用登录窗口未打开或已关闭。");
        await delay(2000, undefined, { signal });
      }
    } catch (error) {
      if (parent.aborted) throw new DOMException("操作已取消。", "AbortError");
      if (signal.aborted) throw new LearnError("ACCOUNT_TIMEOUT", "登录等待已结束，没有持续后台轮询。可手动完成登录后再检查。");
      throw error;
    }
  }

  /** Save only after host-supplied human approval, rechecking account binding afterwards. */
  async authorizeAndSave(approve: ApproveAccount, options?: AccountOperationOptions): Promise<AuthorizationResult> {
    const signal = this.signal(options);
    if (typeof approve !== "function") throw new LearnError("ACCOUNT_APPROVAL", "必须由宿主提供真实的用户确认对话框。");
    const writer = this.options.credentialStore;
    if (!writer) throw new LearnError("ACCOUNT_STORE", "尚未绑定凭据存储；未改动现有配置。");
    return this.serial(async () => {
      signal.throwIfAborted();
      const initial = await this.authenticated(signal);
      const approved = await abortable(Promise.resolve().then(() => {
        signal.throwIfAborted();
        return approve(Object.freeze({ ...initial.account }), signal);
      }), signal);
      signal.throwIfAborted();
      if (approved !== true) return { account: { ...initial.account }, saved: false };
      const current = await this.authenticated(signal);
      const final = await this.cookies(signal);
      if (current.account.uid !== initial.account.uid || current.credentials.sessdata !== initial.credentials.sessdata || !final || final.sessdata !== current.credentials.sessdata) {
        throw new LearnError("ACCOUNT_CHANGED", "确认期间账号或登录态发生变化，已停止保存，请重新确认。");
      }
      signal.throwIfAborted();
      try { await writer.saveCredentials(final); }
      catch { throw new LearnError("ACCOUNT_SAVE", "保存登录态失败，请检查本地存储权限；未回显凭据。"); }
      this.cached = undefined;
      return { account: { ...current.account }, saved: true };
    });
  }

  private async authenticated(signal: AbortSignal): Promise<AuthenticatedSession> {
    const credentials = await this.cookies(signal);
    if (!credentials) throw new LearnError("ACCOUNT_LOGIN_REQUIRED", "请在专用浏览器窗口完成 Bilibili 登录。");
    const account = await this.identity(credentials, signal);
    if (!account) throw new LearnError("ACCOUNT_LOGIN_REQUIRED", "登录态尚未生效或已失效，请在专用浏览器中检查。");
    return { credentials, account };
  }

  /** Clears only the local manual-verification flag, after explicit human confirmation. */
  async resumeAfterManualVerification(confirm: (signal: AbortSignal) => Promise<boolean>, options?: AccountOperationOptions): Promise<boolean> {
    const signal = this.signal(options);
    if (typeof confirm !== "function") throw new LearnError("ACCOUNT_APPROVAL", "恢复访问需要用户确认。");
    return this.serial(async () => {
      if (await abortable(Promise.resolve().then(() => {
        signal.throwIfAborted();
        return confirm(signal);
      }), signal) !== true) return false;
      signal.throwIfAborted();
      const credentials = await this.cookies(signal);
      if (!credentials) throw new LearnError("ACCOUNT_LOGIN_REQUIRED", "专用浏览器中没有有效登录态。");
      await (await this.guard()).resume(credentialHeaders(credentials));
      this.cached = undefined;
      return true; // Platform cooldown is deliberately not cleared.
    });
  }

  /** Close only this module's dedicated browser process; persistent login is not erased. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.disposed = true;
    this.lifetime.abort();
    return this.closePromise = (async () => {
      await this.tail;
      const browser = this.browser;
      this.browser = undefined; this.cached = undefined;
      await browser?.close();
    })();
  }
}
