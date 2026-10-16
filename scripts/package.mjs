import { execFileSync } from 'node:child_process';
import { mkdir, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const archive = `pi-in-codex-${manifest.version}-macos.zip`;
const root = 'release/pi-in-codex';
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
for (const entry of manifest.files) {
  await mkdir(`${root}/${entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '.'}`, { recursive: true });
  await cp(entry, `${root}/${entry}`, { recursive: true });
}
await writeFile(`${root}/INSTALL.txt`, 'Install: node bin/pi-in-codex.mjs install\nDiagnose: node bin/pi-in-codex.mjs doctor\nThen restart Codex, enable Pi in Codex, and review/trust its hooks.\n');
await rm(`release/${archive}`, { force: true });
execFileSync('/usr/bin/zip', ['-qr', archive, 'pi-in-codex'], { cwd: 'release', stdio: 'inherit' });
const checksum = createHash('sha256').update(await readFile(`release/${archive}`)).digest('hex');
await writeFile('release/SHA256SUMS', `${checksum}  ${archive}\n`);
console.log(`Packaged release/${archive} and release/SHA256SUMS`);
