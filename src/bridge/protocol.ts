export interface CallTarget {
  endpoint: string;
  action: string | null;
  method: "GET" | "POST";
  params: Record<string, unknown>;
}
export interface AuthMessage { type: "auth"; token: string; }
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
export interface CaptureMessage { type: "capture"; call: CapturedEntry; }
export type ExtensionMessage = AuthMessage | CallResult | CaptureMessage;
