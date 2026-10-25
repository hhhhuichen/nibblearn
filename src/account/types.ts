import type { Credentials } from "../types.ts";

/** Public account information only. Never include Cookie values or debug endpoints here. */
export interface BilibiliIdentity {
  uid: string;
  name: string;
}

export type AccountStatus =
  | { state: "not-open" }
  | { state: "login-required" }
  | { state: "logged-in"; account: BilibiliIdentity };

/** Implemented structurally by the existing Store; this module does not change Store. */
export interface CredentialWriter {
  saveCredentials(credentials: Credentials): Promise<void>;
}

export type BrowserKind = "edge" | "chrome";
export type BrowserPreference = BrowserKind | "auto";

/** Account logic depends on this interface, not on CDP or a particular browser launcher. */
export interface BrowserSession {
  readonly browser: BrowserKind;
  readonly isOpen: boolean;
  openLoginPage(signal?: AbortSignal): Promise<void>;
  /** Machine-only cookie data, restricted to Bilibili. Never forward this result to a model. */
  readCookies(signal?: AbortSignal): Promise<unknown[]>;
  close(): Promise<void>;
}

export interface ChromiumLaunchOptions {
  /** Auto prefers installed Edge, then Chrome. No browser is downloaded. */
  browser?: BrowserPreference;
  /** Absolute path to an installed browser or a trusted launcher. */
  executablePath?: string;
  homeDirectory?: string;
  /** Dedicated, browser-specific profile only; ordinary user profiles are rejected. */
  profileDirectory?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BilibiliAccountOptions {
  browser?: BrowserPreference;
  executablePath?: string;
  /** Legacy Edge-only alias. Cannot be combined with Chrome or executablePath. */
  edgePath?: string;
  /** Private application state directory, outside the source repository. */
  homeDirectory?: string;
  /** Edge and Chrome must use separate dedicated profiles. */
  profileDirectory?: string;
  credentialStore?: CredentialWriter;
  launchTimeoutMs?: number;
}

export interface AccountOperationOptions {
  signal?: AbortSignal;
}

export interface WaitForLoginOptions extends AccountOperationOptions {
  /** Maximum 10 minutes; default 3 minutes. There is no permanent login polling. */
  timeoutMs?: number;
}

/** Supply a real user confirmation dialog from the host, not a model-generated decision. */
export type ApproveAccount = (account: Readonly<BilibiliIdentity>, signal: AbortSignal) => Promise<boolean>;

export interface AuthorizationResult {
  account: BilibiliIdentity;
  saved: boolean;
}

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(new DOMException("操作已取消。", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new DOMException("操作已取消。", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
