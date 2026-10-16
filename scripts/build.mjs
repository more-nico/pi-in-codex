import { build } from 'esbuild';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
// Packaging includes dist/: never carry old diagnostics or local files forward.
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const backend = await build({ entryPoints: ['src/cli.ts'], outfile: 'dist/cli.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true, metafile: true,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
const ui = await build({ entryPoints: ['web/main.tsx'], outdir: 'dist/web', bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', minify: true, metafile: true, define: { 'process.env.NODE_ENV': '"production"' } });
const javascript = ui.outputFiles.find(file => file.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
const css = ui.outputFiles.find(file => file.path.endsWith('.css')).text;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi agents</title><style>${css}</style></head><body><div id="root"></div><script>${javascript}</script></body></html>`;
await writeFile('dist/panel.html', html);
const packages = new Set();
for (const path of [...Object.keys(backend.metafile.inputs), ...Object.keys(ui.metafile.inputs)]) {
  const match = path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.add(match[1]);
}
let notices = 'Bundled dependency license notices\n';
for (const path of [...packages].sort()) {
  const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const licenses = (await readdir(path)).filter(name => /^(licen[cs]e|copying)(\.|$)/i.test(name));
  notices += `\n\n${manifest.name} ${manifest.version} (${manifest.license || 'see license text'})\n${'='.repeat(72)}\n`;
  for (const license of licenses) notices += await readFile(join(path, license), 'utf8') + '\n';
}
await writeFile('dist/DEPENDENCY_NOTICES.txt', notices);
console.log('Built dist/cli.mjs and self-contained dist/panel.html');
