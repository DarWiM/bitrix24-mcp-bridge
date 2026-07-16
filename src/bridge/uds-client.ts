import { connect, Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type { CallTarget, CallResult } from "./protocol.js";
import type { PortalConnection } from "./daemon.js";

export interface CallSink {
  call(portal: string | undefined, target: CallTarget): Promise<unknown>;
  status(): Promise<{ portals: PortalConnection[] }>;
}

interface UdsClientOptions {
  sockPath: string;
  spawnDaemon?: () => void;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;

export class UdsClient implements CallSink {
  private sock?: Socket;
  private dec = new FrameDecoder();
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  constructor(private opts: UdsClientOptions) {}

  async connect(): Promise<void> {
    const deadline = Date.now() + (this.opts.connectTimeoutMs ?? 5000);
    let spawned = false;
    for (;;) {
      try {
        this.sock = await this.tryConnect();
        break;
      } catch {
        if (!spawned) { this.opts.spawnDaemon?.(); spawned = true; }
        if (Date.now() > deadline) throw new Error(`could not reach daemon at ${this.opts.sockPath}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    this.sock.on("data", (chunk) => {
      for (const msg of this.dec.push(chunk) as CallResult[]) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error ?? "call failed"));
      }
    });
    this.sock.on("close", () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("daemon connection closed")); }
      this.pending.clear();
      this.sock = undefined;
    });
  }

  private tryConnect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect(this.opts.sockPath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }

  private request<T>(kind: "call" | "status", frame: Record<string, unknown>): Promise<T> {
    const sock = this.sock;
    if (!sock || sock.destroyed || !sock.writable) return Promise.reject(new Error("client not connected"));
    const id = String(++this.seq);
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon did not respond to ${kind} in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(encodeFrame({ id, ...frame }));
    });
  }

  call(portal: string | undefined, target: CallTarget): Promise<unknown> {
    return this.request("call", { type: "call", portal, ...target });
  }

  status(): Promise<{ portals: PortalConnection[] }> {
    return this.request<{ portals: PortalConnection[] }>("status", { type: "status" });
  }

  close(): void { this.sock?.destroy(); }
}
