import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { JsonLines } from './jsonl.js';
import { errorText } from './config.js';
import type { PiRecord } from './types.js';

export class PiProcess extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private writing = Promise.resolve();
  private closing = false;
  private closed = false;
  private stderr = '';
  constructor(executable: string, args: string[], cwd: string) {
    super();
    this.child = spawn(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, PI_TELEMETRY: '0' } });
    const decoder = new JsonLines(record => this.record(record), error => this.fail(error));
    this.child.stdout.on('data', chunk => decoder.push(chunk));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + errorText(chunk.toString())).slice(-4000); });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      const error = new Error(`pi exited (${signal || code})${this.stderr ? `: ${this.stderr}` : ''}`);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
      this.emit('closed', this.closing ? undefined : error);
    });
  }
  private fail(error: Error) { this.emit('fault', error); }
  private record(record: PiRecord) {
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(record.id);
        if (record.success) pending.resolve(record.data);
        else pending.reject(new Error(errorText(record.error || 'pi command failed')));
      }
    } else this.emit('record', record);
  }
  async write(record: PiRecord) {
    const task = this.writing.then(async () => {
      if (this.child.exitCode !== null || this.child.signalCode || this.child.stdin.destroyed) throw new Error('pi is not running');
      if (!this.child.stdin.write(JSON.stringify(record) + '\n')) await once(this.child.stdin, 'drain');
    });
    this.writing = task.catch(() => {});
    return task;
  }
  command(type: string, args: PiRecord = {}, timeoutMs = 30_000): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`pi ${type} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...args, type, id }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    if (this.closed) return;
    const exited = once(this.child, 'close').catch(() => {});
    this.child.stdin.end();
    const timer = setTimeout(() => this.signal('SIGTERM'), 3000);
    const hard = setTimeout(() => this.signal('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer); clearTimeout(hard);
  }
  private signal(signal: NodeJS.Signals) {
    try { if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal); else this.child.kill(signal); } catch {}
  }
}
