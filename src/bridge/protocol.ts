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
export type ExtensionMessage = AuthMessage | CallResult;
