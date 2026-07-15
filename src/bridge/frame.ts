export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

export class FrameDecoder {
  private buf = "";
  push(chunk: string | Buffer): unknown[] {
    this.buf += chunk.toString();
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
