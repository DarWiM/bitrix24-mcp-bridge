import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { CallRequest, CallResult, CallTarget, CapturedEntry, ExtensionMessage } from "./protocol.js";

interface BridgeOptions {
  port: number;
  token: string;
  allowedOrigin?: string;
  onCapture?: (call: CapturedEntry) => void; // recording mode (src/capture-server.ts)
}
interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; }

const CALL_TIMEOUT_MS = 30_000;

export class Bridge {
  private wss?: WebSocketServer;
  private extensions = new Set<WebSocket>(); // registry of authenticated tabs (G4)
  private pending = new Map<string, Pending>();

  constructor(private opts: BridgeOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.opts.port }, () => resolve());
      this.wss.on("error", (err) => reject(err));
      this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    });
  }

  private onConnection(ws: WebSocket, req: import("node:http").IncomingMessage) {
    const origin = req.headers.origin;
    if (this.opts.allowedOrigin && origin && origin !== this.opts.allowedOrigin) {
      console.error(`[bridge] rejecting connection from origin ${origin}`);
      ws.close();
      return;
    }
    let authed = false;
    ws.on("message", (raw) => {
      let msg: ExtensionMessage;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(); return; }
      if (!authed) {
        if (msg.type === "auth" && msg.token === this.opts.token) {
          authed = true;
          this.extensions.add(ws);
          console.error("[bridge] extension authenticated");
        } else {
          console.error("[bridge] auth failed — closing socket");
          ws.close();
        }
        return;
      }
      if (msg.type === "result") this.resolvePending(msg);
      else if (msg.type === "capture") this.opts.onCapture?.(msg.call);
    });
    ws.on("close", () => { this.extensions.delete(ws); });
  }

  private resolvePending(result: CallResult) {
    const p = this.pending.get(result.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(result.id);
    if (result.ok) p.resolve(result.data);
    else p.reject(new Error(result.error ?? "extension error"));
  }

  call(target: CallTarget): Promise<unknown> {
    const live = [...this.extensions].find((ws) => ws.readyState === WebSocket.OPEN);
    if (!live) return Promise.reject(new Error("extension not connected"));
    const id = randomUUID();
    const req: CallRequest = { type: "call", id, ...target };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`call ${target.action ?? target.endpoint} timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      live.send(JSON.stringify(req));
    });
  }

  stop(): Promise<void> {
    for (const ws of this.extensions) {
      try { ws.close(); } catch {}
    }
    this.extensions.clear();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("bridge stopped")); }
    this.pending.clear();
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 500);
      this.wss.close(() => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }
}
