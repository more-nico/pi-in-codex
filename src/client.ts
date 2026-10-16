import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { JsonLines } from './jsonl.js';
import { dataRoot, socketPath } from './config.js';
import { daemonRequestTimeout } from './wait.js';
import type { Response } from './types.js';
import lockfile from 'proper-lockfile';
import { BUILD, type BuildInfo } from './build.js';

export function request(method: string, threadId?: string, args: Record<string, any> = {}, timeoutMs = daemonRequestTimeout(method, args), signal?: AbortSignal): Promise<any> {
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
export interface DaemonInfo extends Partial<BuildInfo> { pid: number; instanceId?: string }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const compatibleDaemon = (info: DaemonInfo, expected = BUILD) =>
  info.buildId === expected.buildId && info.protocolVersion === expected.protocolVersion && info.version === expected.version;
async function ping(): Promise<DaemonInfo | undefined> {
  try { return await request('ping', undefined, {}, 500); } catch { return undefined; }
}
export async function withLifecycleLock<T>(action: () => Promise<T>): Promise<T> {
  const root = dataRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(root, { lockfilePath: join(root, 'lifecycle.lock'), stale: 30_000, update: 2000,
    retries: { retries: 200, minTimeout: 200, maxTimeout: 200, randomize: false } });
  try { return await action(); } finally { await release(); }
}
// Caller holds the lifecycle lock. Wait for process exit and lock/socket release
// before replacing files or starting a successor; never force-kill on timeout.
export async function stopDaemon(info?: DaemonInfo, timeoutMs = 15_000) {
  info ??= await ping();
  if (!info) {
    if (await lockfile.check(dataRoot(), { stale: 10_000 })) throw new Error('Daemon is not responding but still holds its process lock. Files were not replaced; run doctor and retry after shutdown.');
    return;
  }
  if (!Number.isInteger(info.pid) || info.pid <= 1 || info.pid === process.pid) throw new Error('Invalid daemon PID');
  const current = await ping();
  if (!current || current.pid !== info.pid || current.instanceId !== info.instanceId) throw new Error('Daemon changed during shutdown; retry');
  if (info.instanceId) await request('daemon_shutdown', undefined, { instanceId: info.instanceId }, 1000);
  else {
    // Migration from 0.1.0, which has no instance-bound shutdown command.
    try { process.kill(info.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let alive = true, locked = true, socket = true;
    try { process.kill(info.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
    try { await access(`${dataRoot()}.lock`); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') locked = false; else throw error; }
    try { await access(socketPath()); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') socket = false; else throw error; }
    if (!alive && !locked && !socket) return;
    await pause(100);
  }
  throw new Error('Daemon did not finish shutting down; files were not replaced. Wait, run doctor, then retry.');
}
export async function ensureDaemon() {
  if (!starting) starting = start().finally(() => { starting = undefined; });
  return starting;
}
async function start() {
  const current = await ping(); if (current && compatibleDaemon(current)) return;
  await withLifecycleLock(async () => {
    const existing = await ping();
    if (existing && compatibleDaemon(existing)) return;
    if (existing) {
      const version = (value?: string) => value?.split('.').map(Number) || [];
      const running = version(existing.version), wanted = version(BUILD.version);
      let newer = false;
      for (let i = 0; i < 3; i++) { if (running[i] !== wanted[i]) { newer = running[i] > wanted[i]; break; } }
      if (newer || existing.version === BUILD.version && existing.builtAt && existing.builtAt > BUILD.builtAt) throw new Error('A newer Pi in Codex daemon is running. Restart Codex to refresh this older plugin client.');
      await stopDaemon(existing);
    }
    const root = dataRoot();
    const log = await open(join(root, 'daemon.log'), 'a', 0o600);
    const deadline = Date.now() + 18_000; let lastSpawn = 0;
    try {
      while (Date.now() < deadline) {
        if (Date.now() - lastSpawn > 2500) {
          const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'daemon'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
          child.on('error', () => {}); child.unref(); lastSpawn = Date.now();
        }
        await pause(100);
        const info = await ping();
        if (info) {
          if (compatibleDaemon(info)) return;
          throw new Error('An incompatible Pi in Codex daemon started. Restart Codex to refresh the plugin.');
        }
      }
      throw new Error(`The pi_in_codex daemon could not start. Run pi-in-codex doctor; see ${join(root, 'daemon.log')}`);
    } finally { await log.close(); }
  });
}
