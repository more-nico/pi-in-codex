/** Opt-in probe of the installed Codex app-server; no model turn or UI installation. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonLines } from '../src/jsonl.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = await mkdtemp(join(tmpdir(), 'pi-codex-host-'));
const executable = process.argv[2] || 'codex';
const home = join(root, 'codex'); await mkdir(home);
const env = { ...process.env, CODEX_HOME: home, PI_IN_CODEX_DATA_DIR: join(root, 'data'), PI_IN_CODEX_SOCKET: join(root, 'daemon.sock') };
await writeFile(join(home, 'config.toml'), '[analytics]\nenabled = false\n');
await promisify(execFile)(process.execPath, ['dist/cli.mjs', 'install', '--codex-home', home], { env });
// A globally configured local-plugins source can shadow an isolated one of the
// same name. Use a distinct catalog and verify its source before installing.
const marketplaceName = 'pi-in-codex-host-smoke';
const marketplacePath = join(home, '.agents/plugins/marketplace.json');
const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
marketplace.name = marketplaceName;
await writeFile(marketplacePath, JSON.stringify(marketplace, null, 2));
await promisify(execFile)(executable, ['plugin', 'marketplace', 'add', home], { env });
const catalog = JSON.parse((await promisify(execFile)(executable, ['plugin', 'list', '--marketplace', marketplaceName, '--available', '--json'], { env })).stdout);
const source = catalog.available?.find((plugin: any) => plugin.name === 'pi-in-codex')?.source?.path;
if (!source || await realpath(source) !== await realpath(join(home, 'plugins/pi-in-codex'))) throw new Error('The smoke marketplace resolved outside the isolated installation');
const installed = JSON.parse((await promisify(execFile)(executable, ['plugin', 'add', `pi-in-codex@${marketplaceName}`, '--json'], { env })).stdout);
const server = spawn(executable, ['app-server', '--stdio'], { env, stdio: 'pipe' });
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>(); let nextId = 0;
let diagnostics = '';
server.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000); });
const decoder = new JsonLines(message => {
  const waiter = pending.get(message.id);
  if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
}, error => console.error(error.message));
server.stdout.on('data', chunk => decoder.push(chunk));
const rpc = (method: string, params: any) => new Promise<any>((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Host ${method} timed out: ${diagnostics}`)); }, 25_000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  server.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
try {
  await rpc('initialize', { clientInfo: { name: 'pi-in-codex-smoke', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  server.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const detail = await rpc('plugin/read', { marketplacePath: join(home, '.agents/plugins/marketplace.json'), pluginName: 'pi-in-codex' });
  if (detail.plugin.hooks.length !== 4 || !detail.plugin.mcpServers.includes('pi_in_codex')) throw new Error('The installed host did not load the plugin hooks and MCP manifest');
  const started = await rpc('thread/start', { cwd: root, ephemeral: true });
  const threadId = started.thread.id;
  let status = await rpc('mcpServerStatus/list', { threadId });
  for (let attempt = 0; !status.data?.length && attempt < 10; attempt++) { await new Promise(resolve => setTimeout(resolve, 200)); status = await rpc('mcpServerStatus/list', { threadId }); }
  const serverInfo = status.data?.find((server: any) => server.name.includes('pi'));
  const panelTool: any = Object.values(serverInfo?.tools || {}).find((tool: any) => tool.name === 'pi_panel');
  if (!panelTool?._meta?.['openai/ui']?.entrypoints?.some((entry: any) => entry.type === 'thread')) throw new Error('The host did not discover the conversation panel entrypoint');
  if (panelTool.title !== 'Pi in Codex' || serverInfo?.serverInfo?.title !== 'Pi in Codex') throw new Error('The host did not retain the Pi in Codex display name');
  if (!serverInfo.serverInfo.icons?.some((icon: any) => icon.mimeType === 'image/svg+xml' && icon.src.startsWith('data:image/svg+xml;base64,'))) throw new Error('The host did not retain the self-contained entrypoint icon');
  await new Promise<void>((resolve, reject) => {
    const hook = spawn(process.execPath, ['dist/cli.mjs', 'hook'], { env, stdio: 'pipe' }); let error = '';
    hook.stderr.on('data', chunk => { error += chunk; }); hook.on('close', code => code ? reject(new Error(error)) : resolve());
    hook.stdin.end(JSON.stringify({ session_id: threadId, cwd: root, hook_event_name: 'UserPromptSubmit', turn_id: 'probe-turn' }));
  });
  const serverName = status.data?.find((server: any) => server.name.includes('pi'))?.name || 'pi_in_codex';
  const response = await rpc('mcpServer/tool/call', { threadId, server: serverName, tool: 'pi_list', arguments: {} });
  await mkdir('release', { recursive: true });
  const report = { timestamp: new Date().toISOString(), perCallThreadMetadataPassed: !response.isError, pluginHooksDiscovered: detail.plugin.hooks.length, conversationPanelEntrypointDiscovered: true, panelTitle: panelTool.title, serverIconDiscovered: true, catalog, installed, response };
  await writeFile('release/host-smoke-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  if (response.isError) process.exitCode = 1;
} catch (error) { console.error('Isolated host diagnostics:', diagnostics); throw error; } finally {
  server.stdin.end(); server.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const stop = spawn(process.execPath, ['dist/cli.mjs', 'daemon-stop'], { env, stdio: 'ignore' }); stop.on('close', () => resolve()); stop.on('error', () => resolve());
  });
  await new Promise(resolve => setTimeout(resolve, 1000)); await rm(root, { recursive: true, force: true });
}
