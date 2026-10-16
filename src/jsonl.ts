/** LF alone frames records. Buffering bytes preserves split UTF-8 and U+2028/U+2029. */
export class JsonLines {
  private buffer = Buffer.alloc(0);
  constructor(private record: (record: any) => void, private failure: (error: Error) => void, private maxBytes = 64 * 1024 * 1024) {}
  push(chunk: Buffer | string) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (line.length > this.maxBytes) { this.failure(new Error('JSONL record too large')); continue; }
      if (!line.toString().trim()) continue;
      try { this.record(JSON.parse(line.toString('utf8'))); }
      catch (error) { this.failure(new Error(`Invalid JSONL record: ${(error as Error).message}`)); }
    }
    if (this.buffer.length > this.maxBytes) { this.buffer = Buffer.alloc(0); this.failure(new Error('Unterminated JSONL record too large')); }
  }
}
