import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, cp, chmod, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { compatibleDaemon, request, stopDaemon, withLifecycleLock } from '../src/client.js';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const cli = join(dist, 'cli.mjs');
const build = JSON.parse(await readFile(join(dist, 'build-info.json'), 'utf8'));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const value = await read(); if (ready(value)) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Lifecycle condition timed out');
}
function execute(args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'pipe' }); let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timed out')); }, 25_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); if (code) reject(new Error(stderr)); else resolve({ stdout, stderr }); });
    child.stdin.end(input);
  });
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'pi-lifecycle-'));
  const previous = { root: process.env.PI_IN_CODEX_DATA_DIR, socket: process.env.PI_IN_CODEX_SOCKET };
  process.env.PI_IN_CODEX_DATA_DIR = join(root, 'data'); process.env.PI_IN_CODEX_SOCKET = join(root, 'daemon.sock');
  const fake = join(root, 'pi'); await cp(new URL('./fixtures/fake-pi.mjs', import.meta.url), fake); await chmod(fake, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PI_IN_CODEX_PI_PATH: fake };
  const children: ChildProcess[] = [];
  t.after(async () => {
    await execute([cli, 'daemon-stop'], env).catch(() => {});
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'close'); child.kill('SIGTERM'); await exited; }
    if (previous.root === undefined) delete process.env.PI_IN_CODEX_DATA_DIR; else process.env.PI_IN_CODEX_DATA_DIR = previous.root;
    if (previous.socket === undefined) delete process.env.PI_IN_CODEX_SOCKET; else process.env.PI_IN_CODEX_SOCKET = previous.socket;
    await rm(root, { recursive: true, force: true });
  });
  const launch = (path: string, args: string[] = []) => { const child = spawn(process.execPath, [path, ...args], { env, stdio: 'ignore' }); children.push(child); return child; };
  const hook = () => execute([cli, 'hook'], env, JSON.stringify({ session_id: 'chat', cwd: root, hook_event_name: 'UserPromptSubmit', turn_id: 'upgrade' }));
  return { root, env, launch, hook };
}

test('concurrent new clients replace an older build once, preserve active work as interrupted, and reuse a matching daemon', async t => {
  const { root, launch, hook } = await fixture(t);
  const older = join(root, 'older'); await cp(dist, older, { recursive: true });
  const olderCli = join(older, 'cli.mjs');
  await writeFile(olderCli, (await readFile(olderCli, 'utf8')).replaceAll(build.buildId, '0'.repeat(64)).replaceAll(`builtAt: ${build.builtAt}`, 'builtAt: 0'));
  const oldProcess = launch(olderCli, ['daemon']);
  const old = await until(() => request('ping'), info => info.pid === oldProcess.pid);
  assert.equal(compatibleDaemon(old, build), false);
  await request('hook_register', 'chat', { cwd: root });
  const child = await request('pi_spawn', 'chat', { name: 'persist me', task: 'hold' });
  await until(() => request('pi_list', 'chat'), list => list.agents[0].status === 'running');
  const output = await Promise.all([hook(), hook()]);
  for (const result of output) assert.equal(result.stderr, '');
  const current = await request('ping');
  assert.notEqual(current.pid, old.pid); assert.equal(compatibleDaemon(current, build), true);
  const list = await request('pi_list', 'chat');
  assert.equal(list.agents[0].id, child.agentId); assert.equal(list.agents[0].status, 'interrupted');
  const waited = await request('pi_wait', 'chat', { agentIds: [child.agentId], timeoutMs: 0 });
  assert.equal(waited.agents[0].result.partial, true);
  await hook(); assert.equal((await request('ping')).pid, current.pid);
  await assert.rejects(request('daemon_shutdown', undefined, { instanceId: old.instanceId }), /instance changed/);
  assert.equal((await request('ping')).pid, current.pid);
});

test('an older cached client refuses to downgrade a newer daemon build', async t => {
  const { root, launch, hook } = await fixture(t);
  const newer = join(root, 'newer'); await cp(dist, newer, { recursive: true });
  const path = join(newer, 'cli.mjs');
  await writeFile(path, (await readFile(path, 'utf8')).replaceAll(build.buildId, 'f'.repeat(64)).replaceAll(`builtAt: ${build.builtAt}`, `builtAt: ${build.builtAt + 60_000}`));
  const child = launch(path, ['daemon']);
  await until(() => request('ping'), info => info.pid === child.pid);
  assert.match((await hook()).stderr, /newer Pi in Codex daemon/);
  assert.equal((await request('ping')).pid, child.pid);
});

test('legacy shutdown waits for actual exit; timeout and an unresponsive lock fail without replacing files', async t => {
  const { root, env, launch } = await fixture(t);
  const home = join(root, 'codex');
  await execute([cli, 'install', '--codex-home', home], env);
  const sentinel = join(home, 'plugins/pi-in-codex/keep-until-shutdown');
  await writeFile(sentinel, 'original installation');
  const path = join(root, 'legacy.mjs');
  await writeFile(path, `import {createServer} from 'node:net';
import {mkdir,rm} from 'node:fs/promises';
const root=process.env.PI_IN_CODEX_DATA_DIR, socket=process.env.PI_IN_CODEX_SOCKET;
await mkdir(root,{recursive:true}); await mkdir(root+'.lock');
const server=createServer(c=>c.on('data',b=>{ const r=JSON.parse(b); if(r.method==='ping' && !process.env.UNRESPONSIVE) c.end(JSON.stringify({id:r.id,result:{version:'0.1.0',pid:process.pid}})+'\\n'); }));
server.listen(socket);
process.on('SIGTERM',()=>setTimeout(async()=>{server.close();await rm(socket,{force:true});await rm(root+'.lock',{recursive:true,force:true});process.exit(0);},700));`);
  let child = launch(path);
  const info = await until(() => request('ping'), info => info.pid === child.pid);
  await assert.rejects(withLifecycleLock(() => stopDaemon(info, 100)), /did not finish shutting down/);
  assert.equal((await request('ping')).pid, child.pid);
  const started = Date.now(); await withLifecycleLock(() => stopDaemon(info));
  assert.ok(Date.now() - started >= 300, 'must wait for delayed legacy exit');
  env.UNRESPONSIVE = '1'; child = launch(path);
  await until(async () => { try { process.kill(child.pid!, 0); return await readFile(path, 'utf8'); } catch { return ''; } }, text => !!text);
  // Wait for its fresh process lock, not a guessed startup sleep.
  await until(async () => { try { return (await import('node:fs/promises')).stat(`${env.PI_IN_CODEX_DATA_DIR}.lock`); } catch { return undefined; } }, value => !!value);
  await assert.rejects(withLifecycleLock(() => stopDaemon()), /not responding.*process lock/);
  await assert.rejects(execute([cli, 'install', '--codex-home', home], env), /not responding.*process lock/);
  assert.equal(await readFile(sentinel, 'utf8'), 'original installation');
});
