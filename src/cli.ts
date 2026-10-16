import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runDaemon } from './daemon.js';
import { runMcp } from './mcp.js';
import { hookMain } from './hooks.js';
import { install, uninstall } from './install.js';
import { dataRoot, socketPath, errorText } from './config.js';
import { request } from './client.js';

async function main() {
  const command = process.argv[2] || 'help';
  const homeIndex = process.argv.indexOf('--codex-home');
  const codexHome = homeIndex >= 0 ? process.argv[homeIndex + 1] : undefined;
  if (homeIndex >= 0 && !codexHome) throw new Error('--codex-home requires a path');
  if (command === 'mcp') return runMcp();
  if (command === 'daemon') return runDaemon();
  if (command === 'hook') return hookMain();
  if (command === 'install' || command === 'uninstall') {
    if (codexHome) process.env.CODEX_HOME = codexHome;
    console.log(JSON.stringify(await (command === 'install' ? install(codexHome) : uninstall(codexHome)), null, 2)); return;
  }
  if (command === 'doctor') {
    let piVersion: string | undefined, piError: string | undefined, daemon: any;
    try { piVersion = (await promisify(execFile)(process.env.PI_IN_CODEX_PI_PATH || 'pi', ['--version'], { timeout: 10_000 })).stdout.trim(); } catch (error) { piError = errorText(error); }
    try { daemon = await request('ping', undefined, {}, 500); } catch { daemon = 'not running (starts on first use)'; }
    const report = { node: process.version, platform: process.platform, supportedPlatform: process.platform === 'darwin', piVersion, piError, dataRoot: dataRoot(), socket: socketPath(), daemon,
      requirements: ['pi >= 1.2.0 with agent_settled and RPC input dialogs', 'Codex host sends per-call thread metadata', 'Plugin hooks are enabled and trusted'],
      testedBaseline: { codex: '26.1013.31256', pi: '1.2.0' } };
    console.log(JSON.stringify(report, null, 2)); if (piError) process.exitCode = 1; return;
  }
  if (command === 'daemon-stop') { const info = await request('ping', undefined, {}, 500); process.kill(info.pid, 'SIGTERM'); console.log('Daemon shutdown requested; active runs will be interrupted.'); return; }
  console.log('pi-in-codex 0.1.0\n\nCommands:\n  install [--codex-home PATH]  Install a local plugin and marketplace entry\n  uninstall [--codex-home PATH] Remove the installed plugin; preserve transcripts\n  doctor                       Check runtime prerequisites\n  daemon-stop                  Stop the local daemon and interrupt active work\n  mcp | hook | daemon          Internal plugin entry points\n');
}
main().catch(error => { process.stderr.write(errorText(error) + '\n'); process.exitCode = 1; });
