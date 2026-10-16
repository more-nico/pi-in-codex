import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, chmod, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { request } from '../src/client.js';
import { MAX_WAIT_MS } from '../src/wait.js';

const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
function execute(args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'pipe' }); let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timed out')); }, 25_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); if (code) reject(new Error(`${code}: ${stderr}`)); else resolve({ stdout, stderr }); }); child.stdin.end(input);
  });
}
const metadata = (threadId: string) => ({ 'x-codex-turn-metadata': { thread_id: threadId, turn_id: 'mcp-turn' } });
const jsonResult = (result: any) => { assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent; };

test('real MCP/stdio/socket/hook chain scopes chats, redelivers at safe points and survives MCP reconnect', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-transports-'));
  const fake = join(root, 'pi');
  await cp(fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url)), fake); await chmod(fake, 0o755);
  const environment = { ...process.env, PI_IN_CODEX_DATA_DIR: join(root, 'data'), PI_IN_CODEX_PI_PATH: fake, PI_IN_CODEX_SOCKET: join(root, 'daemon.sock') };
  const original = { root: process.env.PI_IN_CODEX_DATA_DIR, socket: process.env.PI_IN_CODEX_SOCKET };
  process.env.PI_IN_CODEX_DATA_DIR = environment.PI_IN_CODEX_DATA_DIR; process.env.PI_IN_CODEX_SOCKET = environment.PI_IN_CODEX_SOCKET;
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await execute([cli, 'daemon-stop'], environment).catch(() => {});
    for (let i = 0; i < 60; i++) { try { await access(environment.PI_IN_CODEX_SOCKET); await new Promise(resolve => setTimeout(resolve, 100)); } catch { break; } }
    if (original.root === undefined) delete process.env.PI_IN_CODEX_DATA_DIR; else process.env.PI_IN_CODEX_DATA_DIR = original.root;
    if (original.socket === undefined) delete process.env.PI_IN_CODEX_SOCKET; else process.env.PI_IN_CODEX_SOCKET = original.socket;
    await rm(root, { recursive: true, force: true });
  });
  const hook = async (thread: string, event: string, turn = 'turn-1') => JSON.parse((await execute([cli, 'hook'], environment,
    JSON.stringify({ session_id: thread, cwd: root, hook_event_name: event, turn_id: turn, permission_mode: 'default' }))).stdout);
  // Concurrent first use exercises daemon process locking and private socket startup.
  await Promise.all([hook('chat-a', 'UserPromptSubmit'), hook('chat-b', 'UserPromptSubmit')]);
  const pid = (await request('ping')).pid; assert.ok(pid > 0);
  const attach = async () => {
    const client = new Client({ name: 'pi-in-codex-test', version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: environment as Record<string, string> })); return client;
  };
  let client = await attach();
  const tools = await client.listTools();
  for (const name of ['pi_spawn', 'pi_send', 'pi_stop', 'pi_reply', 'pi_ack']) {
    assert.deepEqual((tools.tools.find(tool => tool.name === name)!._meta!.ui as any).visibility, ['model']);
  }
  assert.deepEqual(tools.tools.find(tool => tool.name === 'pi_poll')!._meta?.ui && (tools.tools.find(tool => tool.name === 'pi_poll')!._meta!.ui as any).visibility, ['app']);
  const resource = await client.readResource({ uri: 'ui://pi-in-codex/panel-v1.html' });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok((resource.contents[0] as any).text.includes('Pi agents'));
  const missing = await client.callTool({ name: 'pi_list', arguments: {} }); assert.equal(missing.isError, true);
  const child = jsonResult(await client.callTool({ name: 'pi_spawn', arguments: { name: '传输测试', task: 'normal' }, _meta: metadata('chat-a') }));
  assert.equal(jsonResult(await client.callTool({ name: 'pi_list', arguments: {}, _meta: metadata('chat-b') })).agents.length, 0);
  const denied = await client.callTool({ name: 'pi_read', arguments: { agentId: child.agentId }, _meta: metadata('chat-b') }); assert.equal(denied.isError, true);
  const waitStarted = Date.now();
  const waited = jsonResult(await client.callTool({ name: 'pi_wait', arguments: { agentIds: [child.agentId], timeoutMs: MAX_WAIT_MS }, _meta: metadata('chat-a') }, undefined, { timeout: MAX_WAIT_MS + 20_000 }));
  assert.ok(Date.now() - waitStarted < 5000, 'An hour-long wait must finish early when the child settles');
  assert.equal(waited.agents[0].status, 'completed');
  const first = await hook('chat-a', 'Stop', 'turn-2'); assert.equal(first.decision, 'block'); assert.match(first.reason, /完成：你好/);
  assert.deepEqual(await hook('chat-a', 'Stop', 'turn-2'), {});
  assert.deepEqual(await hook('chat-b', 'UserPromptSubmit', 'turn-3'), {});
  const later = await hook('chat-a', 'UserPromptSubmit', 'turn-3'); assert.match(later.hookSpecificOutput.additionalContext, /completionId/);
  const completion = waited.agents[0].result;
  jsonResult(await client.callTool({ name: 'pi_ack', arguments: { completionIds: [completion.id] }, _meta: metadata('chat-a') }));
  assert.deepEqual(await hook('chat-a', 'UserPromptSubmit', 'turn-4'), {});
  await client.close(); client = await attach();
  assert.equal((await request('ping')).pid, pid);
  assert.match(jsonResult(await client.callTool({ name: 'pi_read', arguments: { agentId: child.agentId }, _meta: metadata('chat-a') })).messages.at(-1).text, /你好/);
  const interactive = jsonResult(await client.callTool({ name: 'pi_spawn', arguments: { name: 'parent handles input', task: 'dialog' }, _meta: metadata('chat-a') }));
  const needsReply = jsonResult(await client.callTool({ name: 'pi_wait', arguments: { agentIds: [interactive.agentId], timeoutMs: 3000 }, _meta: metadata('chat-a') }));
  assert.equal(needsReply.agents[0].status, 'waiting_input');
  jsonResult(await client.callTool({ name: 'pi_reply', arguments: { agentId: interactive.agentId, requestId: needsReply.agents[0].dialogs[0].id, value: '由主会话处理' }, _meta: metadata('chat-a') }));
  const answered = jsonResult(await client.callTool({ name: 'pi_wait', arguments: { agentIds: [interactive.agentId], timeoutMs: 3000 }, _meta: metadata('chat-a') }));
  assert.equal(answered.agents[0].status, 'completed');
  assert.equal(answered.agents[0].result.text, '由主会话处理');
});

test('isolated install uses marketplace-root paths, retains other plugins, and release bundle runs without node_modules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'codex'), marketplace = join(home, '.agents/plugins/marketplace.json');
  const fake = join(root, 'pi'); await cp(fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url)), fake); await chmod(fake, 0o755);
  await mkdir(join(home, '.agents/plugins'), { recursive: true });
  await writeFile(marketplace, JSON.stringify({ name: 'existing', plugins: [{ name: 'another-plugin', source: { source: 'local', path: './other' } }] }));
  const env = { ...process.env, PI_IN_CODEX_DATA_DIR: join(root, 'data'), PI_IN_CODEX_PI_PATH: fake, PI_IN_CODEX_SOCKET: join(root, 'none.sock') };
  await execute([cli, 'install', '--codex-home', home], env);
  const catalog = JSON.parse(await readFile(marketplace, 'utf8'));
  assert.equal(catalog.name, 'existing'); assert.equal(catalog.plugins[0].name, 'another-plugin');
  const entry = catalog.plugins.find((plugin: any) => plugin.name === 'pi-in-codex');
  const destination = resolve(home, entry.source.path);
  assert.equal(destination, join(home, 'plugins/pi-in-codex'));
  assert.equal(entry.policy.installation, 'AVAILABLE');
  await access(join(destination, 'dist/DEPENDENCY_NOTICES.txt')); await access(`${marketplace}.pi-in-codex-backup`);
  const report = JSON.parse((await execute([join(destination, 'dist/cli.mjs'), 'doctor'], env)).stdout);
  assert.ok(report.piVersion);
  await execute([cli, 'install', '--codex-home', home], env);
  const updated = JSON.parse(await readFile(marketplace, 'utf8')); assert.equal(updated.plugins.filter((plugin: any) => plugin.name === 'pi-in-codex').length, 1);
  await execute([cli, 'uninstall', '--codex-home', home], env);
  const remaining = JSON.parse(await readFile(marketplace, 'utf8')); assert.equal(remaining.plugins.length, 1);
  await assert.rejects(access(destination));
});
