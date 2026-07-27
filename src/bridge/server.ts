import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import type {
  BinaryBeginMessage,
  BinaryChunkMessage,
  CallResult,
  CallTarget,
  CapturedEntry,
  DownloadResult,
  ExtensionMessage,
} from "./protocol.js";

interface BridgeOptions {
  port: number;
  token: string;
  allowedOrigins: string[];
  onCapture?: (call: CapturedEntry) => void; // recording mode (src/capture-server.ts)
}
interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; }
interface Download { path: string; stream: WriteStream; bytes: number; contentType: string; fileName: string | null; }

const CALL_TIMEOUT_MS = 30_000;
// A 100 MB attachment over a slow portal outlives the regular call timeout.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export class Bridge {
  private wss?: WebSocketServer;
  private byOrigin = new Map<string, Set<WebSocket>>(); // authed sockets keyed by reported origin
  private pending = new Map<string, Pending>();
  private downloads = new Map<string, Download>();
  private downloadPaths = new Map<string, string>(); // call id → where its body must land
  private extensionVersions = new Map<WebSocket, string>(); // what each connected copy reports

  constructor(private opts: BridgeOptions) {}

  get port(): number {
    const addr = this.wss?.address();
    return addr && typeof addr === "object" ? (addr as AddressInfo).port : this.opts.port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.opts.port }, () => resolve());
      this.wss.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(
            `port ${this.opts.port} is already in use — another daemon is running. ` +
            `Run a single daemon at a time (or set BITRIX_MCP_PORT).`,
          ));
        } else reject(err);
      });
      this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    });
  }

  private onConnection(ws: WebSocket, req: import("node:http").IncomingMessage) {
    const origin = req.headers.origin;
    if (origin && !this.opts.allowedOrigins.includes(origin)) {
      console.error(`[bridge] rejecting connection from origin ${origin}`);
      ws.close();
      return;
    }
    let authed = false;
    const key = origin ?? ""; // non-browser peers report no origin
    ws.on("message", (raw) => {
      let msg: ExtensionMessage;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(); return; }
      if (!authed) {
        if (msg.type === "auth" && msg.token === this.opts.token) {
          authed = true;
          (this.byOrigin.get(key) ?? this.byOrigin.set(key, new Set()).get(key)!).add(ws);
          // Absent on extensions built before the field existed — treated as "unknown, likely old".
          if (msg.version) this.extensionVersions.set(ws, msg.version);
          console.error(`[bridge] extension authenticated (origin ${key || "<none>"}, version ${msg.version ?? "<unknown>"})`);
        } else {
          console.error("[bridge] auth failed — closing socket");
          ws.close();
        }
        return;
      }
      if (msg.type === "result") this.resolvePending(msg);
      else if (msg.type === "capture") this.opts.onCapture?.(msg.call);
      else if (msg.type === "binary-begin") this.beginDownload(msg);
      else if (msg.type === "binary-chunk") this.writeChunk(msg);
    });
    ws.on("close", () => {
      this.byOrigin.get(key)?.delete(ws);
      this.extensionVersions.delete(ws);
    });
  }

  private beginDownload(msg: BinaryBeginMessage) {
    const path = this.downloadPaths.get(msg.id);
    if (!path) return; // not a download we asked for
    mkdirSync(dirname(path), { recursive: true });
    this.downloads.set(msg.id, {
      path,
      stream: createWriteStream(path),
      bytes: 0,
      contentType: msg.contentType,
      fileName: msg.fileName,
    });
  }

  private writeChunk(msg: BinaryChunkMessage) {
    const dl = this.downloads.get(msg.id);
    if (!dl) return;
    const buf = Buffer.from(msg.data, "base64");
    dl.bytes += buf.length;
    dl.stream.write(buf);
  }

  private resolvePending(result: CallResult) {
    const p = this.pending.get(result.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(result.id);
    const dl = this.downloads.get(result.id);
    this.downloads.delete(result.id);
    this.downloadPaths.delete(result.id);
    // surface the Bitrix error envelope (not just the code) for diagnosis
    const detail = result.data !== undefined ? ` — ${JSON.stringify(result.data).slice(0, 1200)}` : "";
    if (dl) {
      // Close first: the file must be complete before the caller is told where it is, and a
      // failed download must not leave a half-written file looking like a real one.
      dl.stream.end(() => {
        if (result.ok) {
          const done: DownloadResult = { path: dl.path, bytes: dl.bytes, contentType: dl.contentType, fileName: dl.fileName };
          p.resolve(done);
        } else {
          rmSync(dl.path, { force: true });
          p.reject(new Error((result.error ?? "extension error") + detail));
        }
      });
      return;
    }
    if (result.ok) p.resolve(result.data);
    else p.reject(new Error((result.error ?? "extension error") + detail));
  }

  connectedOrigins(): string[] {
    return [...this.byOrigin.entries()]
      .filter(([, set]) => [...set].some((ws) => ws.readyState === WebSocket.OPEN))
      .map(([origin]) => origin);
  }

  /** Version the extension serving this origin reports; null when it predates the field. */
  extensionVersion(origin: string): string | null {
    const live = [...(this.byOrigin.get(origin) ?? [])].find((ws) => ws.readyState === WebSocket.OPEN);
    return live ? this.extensionVersions.get(live) ?? null : null;
  }

  call(origin: string, target: CallTarget): Promise<unknown> {
    return this.dispatch(origin, target, CALL_TIMEOUT_MS);
  }

  /** Like `call`, but the response body is streamed into `destPath` instead of returned. */
  callBinary(origin: string, target: CallTarget, destPath: string): Promise<DownloadResult> {
    return this.dispatch(origin, { ...target, responseType: "binary" }, DOWNLOAD_TIMEOUT_MS, destPath) as Promise<DownloadResult>;
  }

  private dispatch(origin: string, target: CallTarget, timeoutMs: number, destPath?: string): Promise<unknown> {
    const set = this.byOrigin.get(origin);
    const live = set && [...set].find((ws) => ws.readyState === WebSocket.OPEN);
    if (!live) return Promise.reject(new Error(`portal ${origin} not connected — open a logged-in tab`));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.discardDownload(id);
        reject(new Error(`call ${target.action ?? target.endpoint} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // Registered before the request goes out — the first chunk can arrive at any moment after.
      if (destPath !== undefined) this.downloadPaths.set(id, destPath);
      try {
        live.send(JSON.stringify({ type: "call", id, ...target }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.downloadPaths.delete(id);
        reject(new Error(`send to portal ${origin} failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  private discardDownload(id: string) {
    const dl = this.downloads.get(id);
    this.downloads.delete(id);
    this.downloadPaths.delete(id);
    if (dl) dl.stream.end(() => rmSync(dl.path, { force: true }));
  }

  stop(): Promise<void> {
    for (const set of this.byOrigin.values()) for (const ws of set) { try { ws.close(); } catch {} }
    this.byOrigin.clear();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("bridge stopped")); }
    this.pending.clear();
    for (const id of [...this.downloads.keys()]) this.discardDownload(id);
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(); } }, 500);
      this.wss.close(() => { if (!done) { done = true; clearTimeout(t); resolve(); } });
    });
  }
}
