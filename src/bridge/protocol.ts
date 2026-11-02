// Re-exports the shared wire-protocol types (single source: shared/wire.ts).
export type {
  CallTarget,
  AuthMessage,
  CallRequest,
  OpRequest,
  CallResult,
  ExtensionMessage,
  BinaryBeginMessage,
  BinaryChunkMessage,
  DownloadResult,
} from "../../shared/wire.js";
