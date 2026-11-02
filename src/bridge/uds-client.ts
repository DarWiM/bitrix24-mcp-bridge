import { connect, Socket } from "node:net";
import { existsSync } from "node:fs";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type { CallResult, OpRequest } from "./protocol.js";
import type { PortalConnection } from "./daemon.js";

export interface DaemonStatus {
  portals: PortalConnection[];
  version: string;
}

export interface CallSink {
  op(portal: string | undefined, name: string, args: unknown): Promise<unknown>;
  status(): Promise<DaemonStatus>;
}

interface UdsClientOptions {
  sockPath: string;
  spawnDaemon?: () => void;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
// Must stay above the daemon's own download timeout so the daemon's error wins the race
// and the caller learns what actually went wrong instead of a generic client-side timeout.
const DOWNLOAD_REQUEST_TIMEOUT_MS = 11 * 60_000;
const DOWNLOAD_OPS = new Set(["file_download", "call_recording"]);

export class UdsClient implements CallSink {
  private sock?: Socket;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  constructor(private opts: UdsClientOptions) {}

  async connect(): Promise<void> {
    const deadline = Date.now() + (this.opts.connectTimeoutMs ?? 5000);
    let spawned = false;
    let sock: Socket;
    for (;;) {
      try {
        sock = await this.tryConnect();
        break;
      } catch {
        if (!spawned) { this.opts.spawnDaemon?.(); spawned = true; }
        if (Date.now() > deadline) throw new Error(`could not reach daemon at ${this.opts.sockPath}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    this.sock = sock;
    // Per connection: a reconnect must not inherit a half-read frame from the old socket.
    const dec = new FrameDecoder();
    sock.on("data", (chunk) => {
      for (const msg of dec.push(chunk) as CallResult[]) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error ?? "call failed"));
      }
    });
    sock.on("close", () => {
      // The socket of a replaced connection can report its close after the reconnect.
      if (this.sock !== sock) return;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("daemon connection closed")); }
      this.pending.clear();
      this.sock = undefined;
    });
    // 'close' follows and rejects pending (above); swallow the error here to avoid
    // an uncaught exception when the daemon dies abruptly (e.g. ECONNRESET).
    sock.on("error", () => {});
  }

  private tryConnect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect(this.opts.sockPath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }

  private request<T>(kind: "op" | "status", frame: Record<string, unknown>, overrideTimeoutMs?: number): Promise<T> {
    const sock = this.sock;
    if (!sock || sock.destroyed || !sock.writable) return Promise.reject(new Error("client not connected"));
    const id = String(++this.seq);
    const timeoutMs = overrideTimeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon did not respond to ${kind} in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(encodeFrame({ id, ...frame }));
    });
  }

  op(portal: string | undefined, name: string, args: unknown): Promise<unknown> {
    // Downloads outlive the regular request budget — a big attachment takes as long as it takes.
    const timeoutMs = DOWNLOAD_OPS.has(name) ? DOWNLOAD_REQUEST_TIMEOUT_MS : undefined;
    const frame: Omit<OpRequest, "id"> = { type: "op", portal, op: name, args };
    return this.request("op", frame, timeoutMs);
  }

  status(): Promise<DaemonStatus> {
    return this.request<DaemonStatus>("status", { type: "status" });
  }

  close(): void { this.sock?.destroy(); }
}

let shutdownSeq = 0;

export function requestDaemonShutdown(sockPath: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    const id = `shutdown-${++shutdownSeq}`;
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    // Centralized here so every exit path (ack, close, error, timeout) clears it exactly once.
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { s.destroy(); } catch {}
      resolve(v);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    const dec = new FrameDecoder();
    s.once("connect", () => s.write(encodeFrame({ type: "shutdown", id })));
    s.on("data", (c) => {
      let msgs: unknown[];
      try {
        msgs = dec.push(c);
      } catch {
        return; // a malformed frame must never crash the caller; treat it as no ack
      }
      for (const msg of msgs as Array<{ type?: string; id?: string; ok?: boolean }>) {
        // Only OUR matched, successful ack counts — a stray frame must never masquerade as one.
        if (msg?.type === "result" && msg.id === id && msg.ok === true) finish(true);
      }
    });
    s.on("close", () => finish(false));  // no confirmed ack before close → not a confirmed shutdown
    s.on("error", () => finish(false));  // ENOENT/ECONNREFUSED → no daemon
  });
}

// The shutdown ack arrives before the daemon has let go of anything. It unlinks its socket right
// before releasing the WS port, so only once the socket is gone can a respawned daemon take over.
export async function stopDaemon(sockPath: string, timeoutMs = 3000): Promise<boolean> {
  if (!(await requestDaemonShutdown(sockPath, timeoutMs))) return false;
  const deadline = Date.now() + timeoutMs;
  while (existsSync(sockPath)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

// A daemon outlives the client that spawned it, so after an upgrade the previous version can still
// be serving the socket. Dev builds report a sentinel version and must leave the installed daemon alone.
export async function replaceStaleDaemon(
  client: Pick<UdsClient, "status" | "close" | "connect">,
  opts: { version: string; enabled: boolean; stopDaemon: () => Promise<boolean>; log: (line: string) => void },
): Promise<void> {
  if (!opts.enabled) return;
  // Daemons from before this handshake answer status without a version.
  const version = (await client.status()).version || "unknown";
  if (version === opts.version) return;
  if (!(await opts.stopDaemon())) {
    opts.log(`[mcp] daemon ${version} is stale (expected ${opts.version}) but did not stop; using it`);
    return;
  }
  client.close();
  await client.connect();
  opts.log(`[mcp] restarted daemon ${version} → ${opts.version}`);
}
