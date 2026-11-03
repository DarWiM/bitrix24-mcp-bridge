import { connect, Socket } from "node:net";
import { existsSync } from "node:fs";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type { CallResult, OpRequest } from "./protocol.js";
import type { PortalConnection } from "./daemon.js";
import type { OpBudget } from "../ops/operation.js";

export interface DaemonStatus {
  portals: PortalConnection[];
  version: string;
  // Absent from daemons that predate the mutation switch.
  mutations?: boolean;
}

export interface CallSink {
  op(portal: string | undefined, name: string, args: unknown, budget?: OpBudget): Promise<unknown>;
  status(): Promise<DaemonStatus>;
}

interface UdsClientOptions {
  sockPath: string;
  spawnDaemon?: () => void;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
// A download must outlast the daemon's own download timeout, so the daemon's error wins the race
// and the caller learns what actually went wrong instead of a generic client-side timeout.
// "long" fits a default multi-page scan (about ten portal requests at the daemon's 30 s each).
const BUDGET_TIMEOUT_MS: Record<Exclude<OpBudget, "call">, number> = {
  download: 11 * 60_000,
  long: 5 * 60_000 + 5_000,
};

export function budgetTimeoutMs(budget: OpBudget, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): number {
  return budget === "call" ? requestTimeoutMs : BUDGET_TIMEOUT_MS[budget];
}

export class UdsClient implements CallSink {
  private sock?: Socket;
  private connecting?: Promise<void>;
  private pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    sock: Socket;
  }>();
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
    // A replaced socket may never report its close (half-closed, still draining), and nothing
    // sent on it will be answered on the new one.
    if (this.sock && this.sock !== sock) this.drop(this.sock);
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
      this.drop(sock);
      // The socket of a replaced connection can report its close after the reconnect.
      if (this.sock === sock) this.sock = undefined;
    });
    // 'close' follows and rejects pending (above); swallow the error here to avoid
    // an uncaught exception when the daemon dies abruptly (e.g. ECONNRESET).
    sock.on("error", () => {});
  }

  private drop(sock: Socket): void {
    for (const [id, p] of this.pending) {
      if (p.sock !== sock) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error("daemon connection closed"));
    }
    sock.destroy();
  }

  private tryConnect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect(this.opts.sockPath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }

  private live(): Socket | undefined {
    const sock = this.sock;
    return sock && !sock.destroyed && sock.writable ? sock : undefined;
  }

  // The daemon may restart under an open session (upgrade, setup toggling mutations, idle exit):
  // reconnect once per request instead of failing every call until the agent restarts.
  // Concurrent requests share one attempt, so a restart never opens two sockets.
  private async reconnect(): Promise<Socket> {
    this.connecting ??= this.connect().finally(() => { this.connecting = undefined; });
    await this.connecting;
    const sock = this.live();
    if (!sock) throw new Error("client not connected");
    return sock;
  }

  private request<T>(kind: "op" | "status", frame: Record<string, unknown>, overrideTimeoutMs?: number): Promise<T> {
    // Registered in the same tick as the liveness check: a close that lands in between would
    // otherwise find nothing pending to reject, and the request would hang until its timeout.
    const sock = this.live();
    if (sock) return this.send<T>(sock, kind, frame, overrideTimeoutMs);
    return this.reconnect().then((fresh) => this.send<T>(fresh, kind, frame, overrideTimeoutMs));
  }

  private send<T>(sock: Socket, kind: "op" | "status", frame: Record<string, unknown>, overrideTimeoutMs?: number): Promise<T> {
    const id = String(++this.seq);
    const timeoutMs = overrideTimeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon did not respond to ${kind} in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, sock });
      sock.write(encodeFrame({ id, ...frame }));
    });
  }

  op(portal: string | undefined, name: string, args: unknown, budget: OpBudget = "call"): Promise<unknown> {
    const frame: Omit<OpRequest, "id"> = { type: "op", portal, op: name, args };
    return this.request("op", frame, budgetTimeoutMs(budget, this.opts.requestTimeoutMs));
  }

  status(timeoutMs?: number): Promise<DaemonStatus> {
    return this.request<DaemonStatus>("status", { type: "status" }, timeoutMs);
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
// The wait does not depend on the ack: a daemon another client is already stopping refuses the
// request, yet still holds the port until its socket goes.
export async function stopDaemon(sockPath: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await requestDaemonShutdown(sockPath, timeoutMs);
  while (existsSync(sockPath)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

// Short, because the handshake runs before the MCP server answers its host.
const HANDSHAKE_STATUS_TIMEOUT_MS = 3000;

// Semver order, so that two installed versions agree on which daemon wins instead of replacing
// each other in turn. A version that does not parse ("unknown" from a daemon that predates the
// handshake) sorts first.
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  // A release is newer than its own prereleases.
  if (pa[4] === undefined) return 1;
  if (pb[4] === undefined) return -1;
  return Math.sign(pa[4].localeCompare(pb[4], "en", { numeric: true }));
}

// A daemon outlives the client that spawned it, so after an upgrade the previous version can still
// be serving the socket. Only an older daemon is replaced: a newer one serves everything this client
// knows, and replacing it would start a tug of war with that newer client.
// Dev builds report a sentinel version and must leave the installed daemon alone.
export async function replaceStaleDaemon(
  client: Pick<UdsClient, "status" | "close" | "connect">,
  opts: {
    version: string;
    enabled: boolean;
    stopDaemon: () => Promise<boolean>;
    log: (line: string) => void;
    statusTimeoutMs?: number;
  },
): Promise<void> {
  if (!opts.enabled) return;
  const versionOf = async (): Promise<{ version: string } | { error: string }> => {
    try {
      // Daemons from before this handshake answer status without a version.
      return { version: (await client.status(opts.statusTimeoutMs ?? HANDSHAKE_STATUS_TIMEOUT_MS)).version || "unknown" };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

  const before = await versionOf();
  if ("version" in before) {
    const order = compareVersions(before.version, opts.version);
    if (order === 0) return;
    if (order > 0) {
      opts.log(`[mcp] daemon ${before.version} is newer than this client ${opts.version}; leaving it`);
      return;
    }
  }
  if ("error" in before) opts.log(`[mcp] daemon did not answer the version check (${before.error}); restarting it`);
  // Reconnect whatever the stop reports: a daemon stopped by another client has already taken
  // this connection down, and connect() either reaches a live daemon or spawns a fresh one.
  await opts.stopDaemon();
  client.close();
  try {
    await client.connect();
  } catch (e) {
    opts.log(`[mcp] could not reach the respawned daemon: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const after = await versionOf();
  const from = "version" in before ? before.version : "unresponsive";
  if ("version" in after && after.version === opts.version) opts.log(`[mcp] restarted daemon ${from} → ${after.version}`);
  else opts.log(`[mcp] daemon is still ${"version" in after ? after.version : "unresponsive"} after a restart attempt (expected ${opts.version})`);
}
