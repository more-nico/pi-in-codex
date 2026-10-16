import { createServer, createConnection } from 'node:net';
import { mkdir, chmod, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { Manager } from './manager.js';
import { Store } from './store.js';
import { JsonLines } from './jsonl.js';
import { dataRoot, socketPath, errorText } from './config.js';
import { schemas, type ToolName } from './schemas.js';
import type { Request } from './types.js';
import { randomUUID } from 'node:crypto';
import { BUILD } from './build.js';

const identity = { ...BUILD, pid: process.pid, instanceId: randomUUID() };

export async function runDaemon() {
  const root = dataRoot(), path = socketPath(root);
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  let shutdown: (() => Promise<void>) | undefined;
  const release = await lockfile.lock(root, { stale: 10_000, update: 2000, retries: 0, onCompromised: () => { void shutdown?.(); } });
  let manager: Manager | undefined;
  try {
    // The process lock is held before any persistent state or socket is touched.
    const active = await new Promise<boolean>(resolve => { const socket = createConnection(path); socket.on('connect', () => { socket.destroy(); resolve(true); }); socket.on('error', () => resolve(false)); });
    if (active) throw new Error('A daemon already owns this socket');
    await rm(path, { force: true });
    manager = new Manager(new Store(root), { maxConcurrent: Math.max(1, Math.min(32, Number(process.env.PI_IN_CODEX_CONCURRENCY) || 4)),
      maxPerThread: Math.max(1, Math.min(32, Number(process.env.PI_IN_CODEX_CHAT_CONCURRENCY) || 2)) });
    manager.on('diagnostic', (message: string) => process.stderr.write(message + '\n'));
    await manager.init();
    const service = manager;
    const server = createServer(socket => {
      const abort = new AbortController(); let received = false;
      socket.on('close', () => abort.abort()); socket.on('error', () => {});
      const decoder = new JsonLines(async (request: Request) => {
        if (received) return; received = true;
        try {
          if (request.method === 'daemon_shutdown') {
            if (!shutdown) throw new Error('Daemon is still starting; retry');
            if (request.args?.instanceId !== identity.instanceId) throw new Error('Daemon instance changed; retry');
            socket.end(JSON.stringify({ id: request.id, result: { stopping: true } }) + '\n');
            void shutdown!(); return;
          }
          const result = await dispatch(service, request, abort.signal); if (!socket.destroyed) socket.end(JSON.stringify({ id: request.id, result }) + '\n');
        }
        catch (error) { if (!socket.destroyed) socket.end(JSON.stringify({ id: request.id, error: errorText(error) }) + '\n'); }
      }, error => socket.destroy(error));
      socket.on('data', chunk => decoder.push(chunk));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
    await chmod(path, 0o600);
    writeFileSync(join(root, 'daemon.pid'), String(process.pid), { mode: 0o600 });
    let closed = false;
    shutdown = async () => {
      if (closed) return; closed = true;
      server.close(); await service.close(); await rm(path, { force: true }); await rm(join(root, 'daemon.pid'), { force: true }); await release();
      process.exit(0);
    };
    process.once('SIGTERM', () => { void shutdown!(); }); process.once('SIGINT', () => { void shutdown!(); });
  } catch (error) { await manager?.close(); await release(); throw error; }
}

export async function dispatch(manager: Manager, request: Request, signal?: AbortSignal): Promise<any> {
  if (request.method === 'ping') return identity;
  const threadId = request.threadId;
  if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('A conversation ID is required');
  if (request.method === 'hook_register') {
    const args = request.args || {};
    if (typeof args.cwd !== 'string') throw new Error('Hook cwd is missing');
    return manager.register({ threadId, cwd: args.cwd, permissionMode: args.permissionMode, turnId: args.turnId, updatedAt: Date.now() });
  }
  manager.assertParent(threadId);
  if (request.method === 'hook_deliver') {
    if (typeof request.args?.turn !== 'string') throw new Error('Hook turn is missing');
    return manager.deliveries(threadId, request.args.turn);
  }
  if (!(request.method in schemas)) throw new Error('Unknown daemon method');
  const name = request.method as ToolName;
  const args: any = schemas[name].parse(request.args || {});
  const execute = async () => { switch (name) {
    case 'pi_spawn': return manager.spawn(threadId, args);
    case 'pi_list': {
      return manager.list(threadId, args);
    }
    case 'pi_panel': return { ...manager.list(threadId), panel: manager.panels.request(threadId) };
    case 'pi_poll': return manager.poll(threadId, args.cursor, args.waitMs, signal, args.panelId, args.transportVersion);
    case 'pi_read': return manager.read(threadId, args.agentId, args.limit, args.includeTools, args.includePartial, args.before, args);
    case 'pi_send': return manager.send(threadId, args.agentId, args.message, args.mode);
    case 'pi_message': return manager.messageParentToChild(threadId, args.agentId, args.message);
    case 'pi_follow_up': return manager.send(threadId, args.agentId, args.message, 'followUp');
    case 'pi_interrupt': return manager.interrupt(threadId, args.agentId);
    case 'pi_stop': return manager.stop(threadId, args.agentId);
    case 'pi_reply': return manager.reply(threadId, args.agentId, args.requestId, args.value, args.confirmed, args.cancelled);
    case 'pi_wait': return manager.wait(threadId, args.agentIds, args.timeoutMs, signal, args);
    case 'pi_events': return manager.events(threadId, args.afterCursor, args.limit, args.eventId);
    case 'pi_result': return manager.result(threadId, args.completionId, args.offset, args.maxChars);
    case 'pi_ack': return manager.acknowledge(threadId, args.completionIds, args.eventIds);
    case 'pi_archive': return manager.archive(threadId, args.agentId, args.archived);
    case 'pi_models': return manager.models(threadId, args.agentId, args.model);
  } };
  const opensPanel = ['pi_spawn', 'pi_send', 'pi_message', 'pi_follow_up'].includes(name);
  const result = opensPanel ? await manager.idempotent(threadId, name, args, execute) : await execute();
  // UI advice is current presence, never a stale part of an idempotency receipt.
  return opensPanel ? { ...result, panel: manager.panels.status(threadId) } : result;
}
