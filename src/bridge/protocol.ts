// Re-exports the shared wire-protocol types (single source: shared/wire.ts).
export type {
  CallTarget,
  AuthMessage,
  CallRequest,
  CallResult,
  CapturedEntry,
  CaptureMessage,
  ExtensionMessage,
  BinaryBeginMessage,
  BinaryChunkMessage,
  DownloadResult,
} from "../../shared/wire.js";
