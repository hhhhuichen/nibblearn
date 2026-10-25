import { LearnError } from "../types.ts";
import { ChromiumSession } from "./chromium.ts";
import type { BrowserSession } from "./types.ts";

function legacyError(error: unknown): never {
  if (error instanceof LearnError && error.code.startsWith("BROWSER_")) {
    throw new LearnError(`EDGE_${error.code.slice("BROWSER_".length)}`, error.message);
  }
  throw error;
}

/** Compatibility adapter for the original Edge-only API. New code may use ChromiumSession. */
export class EdgeSession implements BrowserSession {
  readonly browser = "edge" as const;
  private readonly session: ChromiumSession;
  private constructor(session: ChromiumSession) { this.session = session; }

  static async launch(options: { profileDirectory: string; edgePath?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<EdgeSession> {
    try {
      const session = await ChromiumSession.launch({
        browser: "edge", executablePath: options.edgePath ?? process.env.NIBBLEARN_EDGE_PATH,
        profileDirectory: options.profileDirectory, timeoutMs: options.timeoutMs, signal: options.signal,
      });
      return new EdgeSession(session);
    } catch (error) { return legacyError(error); }
  }

  get client() { return this.session.client; }
  get isOpen(): boolean { return this.session.isOpen; }
  async openLoginPage(signal?: AbortSignal): Promise<void> {
    try { await this.session.openLoginPage(signal); } catch (error) { legacyError(error); }
  }
  async readCookies(signal?: AbortSignal): Promise<unknown[]> {
    try { return await this.session.readCookies(signal); } catch (error) { return legacyError(error); }
  }
  async close(): Promise<void> {
    try { await this.session.close(); } catch (error) { legacyError(error); }
  }
}
