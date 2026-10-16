import { execFileSync } from 'node:child_process';
import { mkdir, cp, rm, writeFile } from 'node:fs/promises';
const root = 'release/pi-in-codex';
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
for (const entry of ['dist', 'bin', 'scripts/launch.sh', '.codex-plugin', '.mcp.json', 'hooks', 'skills', 'assets', 'README.md', 'README.zh-CN.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  await mkdir(`${root}/${entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '.'}`, { recursive: true });
  await cp(entry, `${root}/${entry}`, { recursive: true });
}
await writeFile(`${root}/INSTALL.txt`, 'Install: node bin/pi-in-codex.mjs install\nDiagnose: node bin/pi-in-codex.mjs doctor\nThen restart Codex, enable Pi in Codex, and review/trust its hooks.\n');
await rm('release/pi-in-codex-0.1.0-macos.zip', { force: true });
execFileSync('/usr/bin/zip', ['-qr', 'pi-in-codex-0.1.0-macos.zip', 'pi-in-codex'], { cwd: 'release', stdio: 'inherit' });
console.log('Packaged release/pi-in-codex-0.1.0-macos.zip');
