import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { CallResult, CallTarget, CapturedEntry, ExtensionMessage } from "./protocol.js";

interface BridgeOptions {
  port: number;
  token: string;
  allowedOrigins: string[];
  onCapture?: (call: CapturedEntry) => void; // recording mode (src/capture-server.ts)
}
interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; }

const CALL_TIMEOUT_MS = 30_000;

export class Bridge {
  private wss?: WebSocketServer;
  private byOrigin = new Map<string, Set<WebSocket>>(); // authed sockets keyed by reported origin
  private pending = new Map<string, Pending>();

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
          console.error(`[bridge] extension authenticated (origin ${key || "<none>"})`);
        } else {
          console.error("[bridge] auth failed — closing socket");
          ws.close();
        }
        return;
      }
      if (msg.type === "result") this.resolvePending(msg);
      else if (msg.type === "capture") this.opts.onCapture?.(msg.call);
    });
    ws.on("close", () => this.byOrigin.get(key)?.delete(ws));
  }

  private resolvePending(result: CallResult) {
    const p = this.pending.get(result.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(result.id);
    if (result.ok) p.resolve(result.data);
    else {
      // surface the Bitrix error envelope (not just the code) for diagnosis
      const detail = result.data !== undefined ? ` — ${JSON.stringify(result.data).slice(0, 1200)}` : "";
      p.reject(new Error((result.error ?? "extension error") + detail));
    }
  }

  connectedOrigins(): string[] {
    return [...this.byOrigin.entries()]
      .filter(([, set]) => [...set].some((ws) => ws.readyState === WebSocket.OPEN))
      .map(([origin]) => origin);
  }

  call(origin: string, target: CallTarget): Promise<unknown> {
    const set = this.byOrigin.get(origin);
    const live = set && [...set].find((ws) => ws.readyState === WebSocket.OPEN);
    if (!live) return Promise.reject(new Error(`portal ${origin} not connected — open a logged-in tab`));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`call ${target.action ?? target.endpoint} timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        live.send(JSON.stringify({ type: "call", id, ...target }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`send to portal ${origin} failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  stop(): Promise<void> {
    for (const set of this.byOrigin.values()) for (const ws of set) { try { ws.close(); } catch {} }
    this.byOrigin.clear();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("bridge stopped")); }
    this.pending.clear();
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(); } }, 500);
      this.wss.close(() => { if (!done) { done = true; clearTimeout(t); resolve(); } });
    });
  }
}
