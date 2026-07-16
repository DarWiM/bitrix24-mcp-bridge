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
}

export class UdsClient implements CallSink {
  private sock?: Socket;
  private dec = new FrameDecoder();
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
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
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error ?? "call failed"));
      }
    });
    this.sock.on("close", () => { for (const p of this.pending.values()) p.reject(new Error("daemon connection closed")); this.pending.clear(); });
  }

  private tryConnect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect(this.opts.sockPath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }

  call(portal: string | undefined, target: CallTarget): Promise<unknown> {
    if (!this.sock) return Promise.reject(new Error("client not connected"));
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock!.write(encodeFrame({ type: "call", id, portal, ...target }));
    });
  }

  status(): Promise<{ portals: PortalConnection[] }> {
    if (!this.sock) return Promise.reject(new Error("client not connected"));
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      // reuse the same pending map; daemon replies with a normal result envelope
      this.pending.set(id, { resolve: (v) => resolve(v as { portals: PortalConnection[] }), reject });
      this.sock!.write(encodeFrame({ type: "status", id }));
    });
  }

  close(): void { this.sock?.destroy(); }
}
