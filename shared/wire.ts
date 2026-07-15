// Wire-protocol types shared by the MCP server (src/) and the browser extension (extension/).
// Pure interfaces — no runtime, no environment (DOM/Bun/node) dependencies — so both
// separately-built TypeScript projects can import them via `import type` (erased at build time).

export interface CallTarget {
  endpoint: string;
  action: string | null;
  method: "GET" | "POST";
  params: Record<string, unknown>;
}

export interface AuthMessage {
  type: "auth";
  token: string;
}

export type CallRequest = CallTarget & { type: "call"; id: string };

export interface CallResult {
  type: "result";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// Sent by the extension's capture build while recording (see src/capture-server.ts).
export interface CapturedEntry {
  endpoint: string;
  action: string | null;
  method: "GET" | "POST";
  transport: "ajax" | "rest" | "other";
  sampleParams: Record<string, string>;
}

export interface CaptureMessage {
  type: "capture";
  call: CapturedEntry;
}

export type ExtensionMessage = AuthMessage | CallResult | CaptureMessage;
