// Wire-protocol types shared by the MCP server (src/) and the browser extension (extension/).
// Pure interfaces — no runtime, no environment (DOM/Bun/node) dependencies — so both
// separately-built TypeScript projects can import them via `import type` (erased at build time).

export interface CallTarget {
  endpoint: string;
  action: string | null;
  method: "GET" | "POST";
  params: Record<string, unknown>;
  bodyType?: "json" | "form";
  // "text" opts a call out of JSON parsing (HTML sub-domain: /call/detail/<id> and friends).
  // "binary" streams the body to a file instead of returning it (attachments, call recordings).
  // Default stays "json" so a broken response still surfaces as an error, not as fake data.
  responseType?: "json" | "text" | "binary";
}

export interface AuthMessage {
  type: "auth";
  token: string;
}

export type CallRequest = CallTarget & { type: "call"; id: string; portal?: string };

export interface CallResult {
  type: "result";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// Binary downloads stream as base64 chunks between "binary-begin" and the usual CallResult,
// so the daemon can write straight to disk instead of holding a whole video in memory.
export interface BinaryBeginMessage {
  type: "binary-begin";
  id: string;
  contentType: string;
  bytes: number;
  fileName: string | null;
}

export interface BinaryChunkMessage {
  type: "binary-chunk";
  id: string;
  seq: number;
  data: string; // base64
}

export interface DownloadResult {
  path: string;
  bytes: number;
  contentType: string;
  fileName: string | null;
}

// Sent by the extension's capture build while recording (see src/capture-server.ts).
export interface CapturedEntry {
  endpoint: string;
  action: string | null;
  method: "GET" | "POST";
  transport: "ajax" | "rest" | "other";
  bodyType: "json" | "form";
  sampleParams: Record<string, unknown>;
}

export interface CaptureMessage {
  type: "capture";
  call: CapturedEntry;
}

export type ExtensionMessage =
  | AuthMessage
  | CallResult
  | CaptureMessage
  | BinaryBeginMessage
  | BinaryChunkMessage;
