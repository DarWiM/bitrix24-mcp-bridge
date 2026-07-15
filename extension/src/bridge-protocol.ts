// Pure, browser-agnostic — unit-tested. No DOM / chrome / window.BX here.
//
// Two concerns live together because both are the *contract* between the extension's
// two content scripts and the packaged config, and both are pure/testable:
//   1) parseConfig  — validate the per-user config.json ({ token, port }).
//   2) the sessid postMessage protocol — the request/response envelope the ISOLATED
//      connector and the MAIN sessid shim exchange over window.postMessage.

export interface BridgeConfig {
  token: string;
  port: number;
}

/**
 * Parse and validate the packaged config.json body. Throws with a clear,
 * user-facing message (mentioning config.json) on any malformed input so the
 * connector can surface why it failed to start.
 */
export function parseConfig(raw: string): BridgeConfig {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error("config.json is not valid JSON");
  }
  if (typeof doc !== "object" || doc === null) {
    throw new Error("config.json must be an object like { token, port }");
  }
  const obj = doc as Record<string, unknown>;
  const token = typeof obj.token === "string" ? obj.token.trim() : "";
  if (!token) throw new Error("config.json is missing a non-empty `token`");
  const port = Number(obj.port);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("config.json is missing a numeric `port`");
  }
  return { token, port };
}

// --- sessid postMessage protocol -------------------------------------------
//
// window.postMessage is delivered to BOTH the MAIN and ISOLATED worlds of the same
// frame (they share the DOM window), and each world also receives its own posts. So
// every envelope is tagged with a fixed `source` and a `kind`, and each side ignores
// anything that isn't addressed to it. Responses additionally carry the request nonce
// so the connector can match a reply to the exact in-flight request it issued.

export const BRIDGE_MSG_SOURCE = "bitrix24-mcp-bridge";

export interface SessidRequestMsg {
  source: typeof BRIDGE_MSG_SOURCE;
  kind: "sessid-request";
  nonce: string;
}

export interface SessidResponseMsg {
  source: typeof BRIDGE_MSG_SOURCE;
  kind: "sessid-response";
  nonce: string;
  sessid: string;
}

export function buildSessidRequest(nonce: string): SessidRequestMsg {
  return { source: BRIDGE_MSG_SOURCE, kind: "sessid-request", nonce };
}

export function buildSessidResponse(nonce: string, sessid: string): SessidResponseMsg {
  return { source: BRIDGE_MSG_SOURCE, kind: "sessid-response", nonce, sessid };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** For the MAIN shim: a well-formed request from our connector, or null. */
export function parseSessidRequest(data: unknown): SessidRequestMsg | null {
  if (!isRecord(data)) return null;
  if (data.source !== BRIDGE_MSG_SOURCE || data.kind !== "sessid-request") return null;
  if (typeof data.nonce !== "string") return null;
  return { source: BRIDGE_MSG_SOURCE, kind: "sessid-request", nonce: data.nonce };
}

/** For the ISOLATED connector: a response matching `expectedNonce`, or null. */
export function parseSessidResponse(data: unknown, expectedNonce: string): SessidResponseMsg | null {
  if (!isRecord(data)) return null;
  if (data.source !== BRIDGE_MSG_SOURCE || data.kind !== "sessid-response") return null;
  if (typeof data.nonce !== "string" || data.nonce !== expectedNonce) return null;
  if (typeof data.sessid !== "string") return null;
  return { source: BRIDGE_MSG_SOURCE, kind: "sessid-response", nonce: data.nonce, sessid: data.sessid };
}
