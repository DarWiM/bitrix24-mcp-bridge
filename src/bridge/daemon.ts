import { createServer, connect, Server, Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { Bridge } from "./server.js";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type { CallResult } from "./protocol.js";

export interface DaemonOptions {
  port: number;
  token: string;
  portals: Record<string, { origin: string }>;
  sockPath: string;
  idleMs?: number;
}

export class DaemonAlreadyRunning extends Error {
  constructor(sock: string) { super(`a daemon is already running on ${sock}`); }
}

export class Daemon {
  private bridge: Bridge;
  private uds?: Server;
  private clients = new Set<Socket>();
  private idleTimer?: NodeJS.Timeout;

  constructor(private opts: DaemonOptions) {
    this.bridge = new Bridge({
      port: opts.port,
      token: opts.token,
      allowedOrigins: Object.values(opts.portals).map((p) => p.origin),
    });
  }

  async start(): Promise<void> {
    await this.reserveSocket();
    await this.bridge.start();
    this.uds = createServer((sock) => this.onClient(sock));
    await new Promise<void>((resolve, reject) => {
      this.uds!.once("error", reject);
      this.uds!.listen(this.opts.sockPath, () => resolve());
    });
    this.armIdle();
    console.error(`[daemon] ws :${this.opts.port} + uds ${this.opts.sockPath}`);
  }

  // Singleton: if the socket answers, another daemon owns it. If it's stale, unlink it.
  private reserveSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!existsSync(this.opts.sockPath)) return resolve();
      const probe = connect(this.opts.sockPath);
      probe.once("connect", () => { probe.destroy(); reject(new DaemonAlreadyRunning(this.opts.sockPath)); });
      probe.once("error", () => { try { unlinkSync(this.opts.sockPath); } catch {} resolve(); });
    });
  }

  private onClient(sock: Socket) {
    this.clients.add(sock);
    this.armIdle();
    const dec = new FrameDecoder();
    sock.on("data", (chunk) => {
      for (const msg of dec.push(chunk) as any[]) {
        if (msg?.type !== "call") continue;
        const origin = this.resolveOrigin(msg.portal);
        const reply = (r: CallResult) => sock.write(encodeFrame(r));
        if (!origin) {
          reply({ type: "result", id: msg.id, ok: false, error: `unknown portal "${msg.portal}"` });
          continue;
        }
        this.bridge.call(origin, { endpoint: msg.endpoint, action: msg.action, method: msg.method, params: msg.params })
          .then((data) => reply({ type: "result", id: msg.id, ok: true, data }))
          .catch((e) => reply({ type: "result", id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
    });
    sock.on("close", () => { this.clients.delete(sock); this.armIdle(); });
    sock.on("error", () => { this.clients.delete(sock); this.armIdle(); });
  }

  private resolveOrigin(portal: string | undefined): string | undefined {
    const entries = Object.entries(this.opts.portals);
    if (!portal) return entries.length === 1 ? entries[0][1].origin : undefined;
    return this.opts.portals[portal]?.origin;
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.opts.idleMs ?? 300_000;
    this.idleTimer = setTimeout(() => {
      if (this.clients.size === 0 && this.bridge.connectedOrigins().length === 0) {
        console.error("[daemon] idle — shutting down");
        this.stop();
      } else this.armIdle();
    }, ms);
    this.idleTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const c of this.clients) { try { c.destroy(); } catch {} }
    this.clients.clear();
    await new Promise<void>((r) => (this.uds ? this.uds.close(() => r()) : r()));
    try { if (existsSync(this.opts.sockPath)) unlinkSync(this.opts.sockPath); } catch {}
    await this.bridge.stop();
  }
}
