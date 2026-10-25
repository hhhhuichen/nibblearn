import { LearnError } from "../types.ts";

type Command = "Target.createTarget" | "Target.attachToTarget" | "Network.getCookies" | "Browser.close";
interface Pending {
  sessionId?: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Internal, dependency-free CDP connection. Only a locally launched browser is accepted. */
export class CdpClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", event => this.receive(event.data));
    socket.addEventListener("close", () => this.fail());
    socket.addEventListener("error", () => this.fail());
  }

  static async connect(endpoint: string, signal?: AbortSignal): Promise<CdpClient> {
    let url: URL;
    try { url = new URL(endpoint); }
    catch { throw new LearnError("BROWSER_ENDPOINT", "浏览器调试端点无效。"); }
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !/^[0-9]+$/.test(url.port)
      || Number(url.port) < 1024 || Number(url.port) > 65535 || url.username || url.password || url.search || url.hash
      || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
      throw new LearnError("BROWSER_ENDPOINT", "只允许连接模块启动的本机浏览器调试端点。");
    }
    signal?.throwIfAborted();
    let socket: WebSocket;
    try { socket = new WebSocket(url); }
    catch { throw new LearnError("BROWSER_CONNECTION", "无法建立本机浏览器连接。"); }
    const client = new CdpClient(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new LearnError("BROWSER_TIMEOUT", "连接浏览器超时。")); }, 10000);
        const onOpen = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new LearnError("BROWSER_CONNECTION", "无法连接本机浏览器；未记录调试地址。")); };
        const onAbort = () => { cleanup(); reject(new DOMException("操作已取消。", "AbortError")); };
        const cleanup = () => {
          clearTimeout(timer);
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onError);
          socket.removeEventListener("close", onError);
          signal?.removeEventListener("abort", onAbort);
        };
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
        socket.addEventListener("close", onError, { once: true });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      return client;
    } catch (error) { client.close(); throw error; }
  }

  get isOpen(): boolean { return !this.closed && this.socket.readyState === WebSocket.OPEN; }

  async send<T>(method: Command, params: Record<string, unknown> = {}, sessionId?: string, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!this.isOpen) throw new LearnError("BROWSER_DISCONNECTED", "专用浏览器窗口已断开，请重新连接。");
    if (this.pending.size >= 32) throw new LearnError("BROWSER_BUSY", "浏览器请求队列已满。");
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); this.pending.delete(id); };
      const timer = setTimeout(() => { cleanup(); reject(new LearnError("BROWSER_TIMEOUT", "浏览器操作超时。")); }, 20000);
      const onAbort = () => { cleanup(); reject(new DOMException("操作已取消。", "AbortError")); };
      this.pending.set(id, { sessionId, resolve: value => resolve(value as T), reject, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { cleanup(); reject(new LearnError("BROWSER_DISCONNECTED", "浏览器连接已断开。")); }
    });
  }

  private receive(data: unknown): void {
    if (typeof data !== "string" || data.length > 2 * 1024 * 1024) { this.close(); return; }
    let message: { id?: number; result?: unknown; error?: unknown; sessionId?: string };
    try { message = JSON.parse(data); } catch { this.close(); return; }
    if (!message || typeof message !== "object" || !Number.isSafeInteger(message.id)) return;
    const request = this.pending.get(message.id!);
    if (!request) return; // Unsolicited page events are not logged, persisted or forwarded.
    request.cleanup();
    if (request.sessionId !== message.sessionId || message.error) {
      request.reject(new LearnError("BROWSER_PROTOCOL", "浏览器未完成请求；未回显可能包含账号信息的协议详情。"));
    } else request.resolve(message.result);
  }

  private fail(): void {
    this.closed = true;
    for (const request of [...this.pending.values()]) {
      request.cleanup();
      request.reject(new LearnError("BROWSER_DISCONNECTED", "专用浏览器窗口已关闭或连接中断。"));
    }
  }

  close(): void {
    this.fail();
    try { this.socket.close(); } catch { /* Already disconnected. */ }
  }
}
