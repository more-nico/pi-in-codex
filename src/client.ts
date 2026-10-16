import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { JsonLines } from './jsonl.js';
import { dataRoot, socketPath } from './config.js';
import type { Response } from './types.js';

export function request(method: string, threadId?: string, args: Record<string, any> = {}, timeoutMs = 70_000, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = randomUUID(), socket = createConnection(socketPath()); let done = false;
    const finish = (error?: Error, result?: unknown) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const onAbort = () => finish(new Error('Request cancelled'));
    const timer = setTimeout(() => finish(new Error('Daemon request timed out')), timeoutMs);
    const decoder = new JsonLines((response: Response) => { if (response.id === id) finish(response.error ? new Error(response.error) : undefined, response.result); }, error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, threadId, args }) + '\n'));
    socket.on('data', chunk => decoder.push(chunk)); socket.on('error', error => finish(error));
    socket.on('end', () => { if (!done) finish(new Error('Daemon connection closed without a response')); });
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
  });
}
let starting: Promise<void> | undefined;
export async function ensureDaemon() {
  if (!starting) starting = start().finally(() => { starting = undefined; });
  return starting;
}
async function start() {
  try { await request('ping', undefined, {}, 500); return; } catch {}
  const root = dataRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
  const log = await open(join(root, 'daemon.log'), 'a', 0o600);
  const deadline = Date.now() + 18_000; let lastSpawn = 0;
  try {
    while (Date.now() < deadline) {
      if (Date.now() - lastSpawn > 2500) {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'daemon'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
        child.on('error', () => {}); child.unref(); lastSpawn = Date.now();
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      try { await request('ping', undefined, {}, 500); return; } catch {}
    }
    throw new Error(`The pi_in_codex daemon could not start. Run pi-in-codex doctor; see ${join(root, 'daemon.log')}`);
  } finally { await log.close(); }
}
