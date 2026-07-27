import { StringDecoder } from "node:string_decoder";

export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

export class FrameDecoder {
  private buf = "";
  // Socket chunks split at arbitrary byte offsets — including mid-character. Decoding each
  // chunk on its own turns a straddling UTF-8 sequence into two U+FFFD; StringDecoder holds
  // the incomplete tail back until the next chunk completes it.
  private decoder = new StringDecoder("utf8");

  push(chunk: string | Buffer): unknown[] {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) out.push(JSON.parse(line));
    }
    return out;
  }
}
