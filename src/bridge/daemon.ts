import { createServer, Server, Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { Bridge } from "./server.js";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type { CallResult } from "./protocol.js";
import { OPERATIONS } from "../ops/index.js";
import { OpRefusedError, type OpContext } from "../ops/operation.js";
import { createRegistry, runOperation, type Registry } from "../ops/registry.js";
import { PACKAGE_VERSION } from "../version.js";

export interface PortalConnection {
  alias: string;
  origin: string;
  connected: boolean;
  /** Version the connected extension reports; null when it is too old to report one. */
  extensionVersion?: string | null;
}

export interface DaemonOptions {
  port: number;
  token: string;
  portals: Record<string, { origin: string }>;
  sockPath: string;
  idleMs?: number;
  defaultPortal: string;
  downloadsDir: string;
  allowMutations: boolean;
  registry?: Registry;
}

// Frames come straight off the socket as untyped JSON: every field is checked where it is used.
const udsRequest = z.object({ type: z.unknown(), id: z.unknown(), portal: z.unknown(), op: z.unknown(), args: z.unknown() });
type UdsRequest = z.infer<typeof udsRequest>;

export class DaemonAlreadyRunning extends Error {
  constructor(sock: string) { super(`a daemon is already running on ${sock}`); }
}

export class Daemon {
  private bridge: Bridge;
  private registry: Registry;
  private origins: Record<string, string>;
  private uds?: Server;
  private clients = new Set<Socket>();
  private idleTimer?: NodeJS.Timeout;
  private ownsSocket = false;
  private stopping = false;

  constructor(private opts: DaemonOptions) {
    this.bridge = new Bridge({
      port: opts.port,
      token: opts.token,
      allowedOrigins: Object.values(opts.portals).map((p) => p.origin),
    });
    this.registry = opts.registry ?? createRegistry(OPERATIONS);
    this.origins = Object.fromEntries(Object.entries(opts.portals).map(([alias, p]) => [alias, p.origin]));
  }

  get port(): number {
    return this.bridge.port;
  }

  async start(): Promise<void> {
    // The WS port is the atomic singleton gate: bind() either succeeds (we are the
    // sole daemon) or fails with EADDRINUSE. No probe→unlink TOCTOU on the socket file.
    try {
      await this.bridge.start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already in use")) throw new DaemonAlreadyRunning(this.opts.sockPath);
      throw e;
    }
    // We own the port → sole daemon. Only now is it safe to reclaim a stale UDS path.
    const sockPath = this.opts.sockPath;
    try {
      mkdirSync(dirname(sockPath), { recursive: true, mode: 0o700 });
      if (existsSync(sockPath)) unlinkSync(sockPath);
      this.uds = createServer((sock) => this.onClient(sock));
      await new Promise<void>((resolve, reject) => {
        this.uds!.once("error", reject);
        this.uds!.listen(sockPath, () => resolve());
      });
      // The design's sole UDS trust boundary is fs permissions (no token on the UDS):
      // force 0600 regardless of umask now that the socket file exists.
      chmodSync(sockPath, 0o600);
    } catch (e) {
      // UDS setup failed AFTER the WS port was bound. Roll back so the port is released;
      // otherwise the next daemon would falsely see DaemonAlreadyRunning on a dead one.
      if (this.uds) { try { this.uds.close(); } catch {} this.uds = undefined; }
      await this.bridge.stop();
      throw e;
    }
    this.ownsSocket = true;
    this.armIdle();
    console.error(`[daemon] ws :${this.bridge.port} + uds ${sockPath}`);
  }

  private onClient(sock: Socket) {
    this.clients.add(sock);
    this.armIdle();
    const dec = new FrameDecoder();
    sock.on("data", (chunk) => {
      // A malformed frame must never crash the daemon (that would kill routing for
      // every portal). Drop the bad data for this connection and keep serving.
      try {
        for (const frame of dec.push(chunk)) this.onRequest(sock, frame);
      } catch (e) {
        console.error(`[daemon] dropping malformed UDS data: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    sock.on("close", () => { this.clients.delete(sock); this.armIdle(); });
    sock.on("error", () => { this.clients.delete(sock); this.armIdle(); });
  }

  private onRequest(sock: Socket, frame: unknown) {
    const parsed = udsRequest.safeParse(frame);
    // Without a string id no client can be waiting on a reply, so there is no one to answer.
    if (!parsed.success || typeof parsed.data.id !== "string") {
      console.error("[daemon] dropping UDS request without a string id");
      return;
    }
    const req = parsed.data;
    const id = parsed.data.id;
    const reply = (r: CallResult) => sock.write(encodeFrame(r));
    switch (req.type) {
      case "shutdown":
        // setImmediate alone is not a flush barrier — sequence stop() on the WRITE
        // CALLBACK so sock.destroy() can never race the buffered ack.
        sock.write(encodeFrame({ type: "result", id, ok: true, data: { stopping: true } }), () => {
          setImmediate(() => void this.stop());
        });
        return;
      case "status": {
        const connected = this.bridge.connectedOrigins();
        const portals: PortalConnection[] = Object.entries(this.opts.portals).map(
          ([alias, p]) => ({
            alias,
            origin: p.origin,
            connected: connected.includes(p.origin),
            extensionVersion: this.bridge.extensionVersion(p.origin),
          }),
        );
        reply({ type: "result", id, ok: true, data: { portals, version: PACKAGE_VERSION } });
        return;
      }
      case "op":
        this.handleOp(id, req, reply);
        return;
      default:
        // A client waiting on this id would otherwise hang until its own timeout.
        reply({ type: "result", id, ok: false, error: `unsupported request type ${String(req.type)}` });
    }
  }

  private handleOp(id: string, frame: UdsRequest, reply: (r: CallResult) => void) {
    const fail = (e: unknown) => reply({ type: "result", id, ok: false, error: e instanceof Error ? e.message : String(e) });
    if (typeof frame.op !== "string") return fail("invalid op request: op must be a string");
    if (frame.portal !== undefined && typeof frame.portal !== "string") return fail("invalid op request: portal must be a string");
    // An empty portal means "the default", like an absent one.
    const alias = frame.portal || this.opts.defaultPortal;
    if (!Object.hasOwn(this.origins, alias)) return fail(`unknown portal "${alias}"`);
    runOperation(this.registry, frame.op, frame.args, this.opContext(alias), { allowMutations: this.opts.allowMutations })
      .then((data) => reply({ type: "result", id, ok: true, data }))
      .catch(fail);
  }

  private opContext(alias: string): OpContext {
    // hasOwn, not a plain lookup: an alias like "constructor" must not resolve to a prototype member.
    const originOf = (portal: string) => {
      if (!Object.hasOwn(this.origins, portal)) throw new OpRefusedError(`unknown portal "${portal}"`);
      return this.origins[portal];
    };
    return {
      portal: alias,
      origin: this.origins[alias],
      origins: { ...this.origins },
      downloadsDir: this.opts.downloadsDir,
      call: async (target, portal = alias) => this.bridge.call(originOf(portal), target),
      callBinary: async (target, destPath, portal = alias) => this.bridge.callBinary(originOf(portal), target, destPath),
    };
  }

  private armIdle() {
    // After stop() the socket destroys fire close/error handlers that call armIdle()
    // again — cross-generation. Once stopping, every re-arm path is a no-op so a
    // dead instance can never re-fire and stop() a NEW daemon on the same port/path.
    if (this.stopping) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.opts.idleMs ?? 300_000;
    this.idleTimer = setTimeout(() => {
      if (this.stopping) return; // a late timer that slipped past clearTimeout is harmless
      if (this.clients.size === 0 && this.bridge.connectedOrigins().length === 0) {
        console.error("[daemon] idle — shutting down");
        this.stop();
      } else this.armIdle();
    }, ms);
    this.idleTimer.unref?.();
  }

  async stop(): Promise<void> {
    // Idempotent: a second stop() (e.g. a guarded loser, or a re-armed idle timer)
    // must not run the teardown again. Set the latch FIRST so any close/error handler
    // fired by the destroys below sees stopping and short-circuits armIdle().
    if (this.stopping) return;
    this.stopping = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const c of this.clients) { try { c.destroy(); } catch {} }
    this.clients.clear();
    await new Promise<void>((r) => (this.uds ? this.uds.close(() => r()) : r()));
    // Only unlink the socket if we won the singleton race and created it. A daemon that
    // lost at bridge.start() must never delete the winner's live socket.
    try { if (this.ownsSocket && existsSync(this.opts.sockPath)) unlinkSync(this.opts.sockPath); } catch {}
    // stop() must never reject: it is called both awaited AND floating (the idle timer and the
    // shutdown-ack write callback do `void this.stop()`). A rejection from bridge teardown would
    // otherwise surface as an unhandled promise rejection.
    try { await this.bridge.stop(); } catch {}
  }
}
