import { cp, mkdir, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dataRoot } from './config.js';
import { request } from './client.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = ['dist', 'bin', 'scripts/launch.sh', '.codex-plugin', '.mcp.json', 'hooks', 'skills', 'assets', 'README.md', 'README.zh-CN.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
function locations(codexHome?: string) {
  const home = resolve(codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'));
  // A custom CODEX_HOME must not mutate the real user's marketplace.
  const marketplace = codexHome || process.env.CODEX_HOME ? join(home, '.agents', 'plugins', 'marketplace.json') : join(homedir(), '.agents', 'plugins', 'marketplace.json');
  return { home, destination: join(home, 'plugins', 'pi-in-codex'), marketplace };
}
async function readMarketplace(path: string): Promise<any> {
  try { const value = JSON.parse(await readFile(path, 'utf8')); if (!Array.isArray(value.plugins)) throw new Error('Existing marketplace has no plugins array'); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { name: 'local-plugins', interface: { displayName: 'Local plugins' }, plugins: [] }; throw error; }
}
async function saveMarketplace(path: string, value: any) {
  await mkdir(dirname(path), { recursive: true });
  try { await cp(path, `${path}.pi-in-codex-backup`, { errorOnExist: false }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path);
}
export async function install(codexHome?: string) {
  const { destination, marketplace } = locations(codexHome);
  await access(join(root, 'dist', 'panel.html'));
  const catalog = await readMarketplace(marketplace);
  const stage = `${destination}.stage-${randomUUID()}`;
  await mkdir(stage, { recursive: true });
  try {
    for (const entry of entries) { await mkdir(dirname(join(stage, entry)), { recursive: true }); await cp(join(root, entry), join(stage, entry), { recursive: true }); }
    // Codex 26.1013 loads the compatibility manifest. Resolve paths at install
    // time: its legacy MCP loader does not expand the portable PLUGIN_ROOT token.
    const mcp = JSON.parse(await readFile(join(stage, '.mcp.json'), 'utf8'));
    mcp.mcpServers.pi_in_codex.command = '/bin/sh';
    mcp.mcpServers.pi_in_codex.args = [join(destination, 'scripts/launch.sh'), 'mcp'];
    await writeFile(join(stage, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
    const hooks = JSON.parse(await readFile(join(stage, 'hooks/hooks.json'), 'utf8'));
    const shellPath = "'" + join(destination, 'scripts/launch.sh').replace(/'/g, "'\\''") + "'";
    for (const groups of Object.values(hooks.hooks) as any[][]) for (const group of groups) for (const hook of group.hooks) hook.command = `/bin/sh ${shellPath} hook`;
    await writeFile(join(stage, 'hooks/hooks.json'), JSON.stringify(hooks, null, 2) + '\n');
    await writeFile(join(stage, '.pi-in-codex-install.json'), JSON.stringify({ version: '0.1.0', node: process.execPath }), { mode: 0o600 });
    await writeFile(join(stage, 'node-path'), process.execPath + '\n', { mode: 0o600 });
    try {
      await access(destination);
      const marker = JSON.parse(await readFile(join(destination, '.pi-in-codex-install.json'), 'utf8'));
      if (!marker.version) throw new Error('Installation ownership marker is missing');
      // Stop the old bundle before replacing files. Running tasks are preserved as interrupted.
      try { const info = await request('ping', undefined, {}, 300); process.kill(info.pid, 'SIGTERM'); await new Promise(resolve => setTimeout(resolve, 5500)); } catch {}
      const backup = `${destination}.previous`;
      await rm(backup, { recursive: true, force: true }); await rename(destination, backup);
      try { await rename(stage, destination); } catch (error) { await rename(backup, destination); throw error; }
      await rm(backup, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') await rename(stage, destination); else throw error; }
    // source.path resolves from the root containing .agents/, not from the catalog folder.
    const marketplaceRoot = resolve(dirname(marketplace), '../..');
    const path = './' + relative(marketplaceRoot, destination).split('\\').join('/');
    catalog.plugins = catalog.plugins.filter((plugin: any) => plugin.name !== 'pi-in-codex');
    catalog.plugins.push({ name: 'pi-in-codex', source: { source: 'local', path }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity', interface: { displayName: 'Pi in Codex', shortDescription: 'Conversation-scoped Pi agents' } });
    await saveMarketplace(marketplace, catalog);
    return { destination, marketplace, next: 'Restart Codex, install Pi in Codex from the Local plugins source, review/trust its hooks, then start a new turn and open Pi agents in the current conversation panel.' };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export async function uninstall(codexHome?: string) {
  const { destination, marketplace } = locations(codexHome);
  const catalog = await readMarketplace(marketplace);
  const marker = JSON.parse(await readFile(join(destination, '.pi-in-codex-install.json'), 'utf8'));
  if (!marker.version) throw new Error('Refusing to remove an unrecognized directory');
  try { const info = await request('ping', undefined, {}, 300); process.kill(info.pid, 'SIGTERM'); await new Promise(resolve => setTimeout(resolve, 5500)); } catch {}
  catalog.plugins = catalog.plugins.filter((plugin: any) => plugin.name !== 'pi-in-codex');
  await saveMarketplace(marketplace, catalog); await rm(destination, { recursive: true });
  return { removed: destination, preservedData: dataRoot() };
}
