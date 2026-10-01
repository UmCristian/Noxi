import { access, cp, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
async function check(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = `${dir}/${item.name}`;
    if (item.isDirectory()) await check(file);
    else if (/\.(m?js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status) throw new Error(result.stderr);
    }
    if (/\.(html|css)$/.test(file)) {
      const source = await readFile(file, 'utf8');
      const refs = [
        ...source.matchAll(/(?:src|href)="(\/[^"#?]+)"|url\(['"]?(\/[^)'"?#]+)['"]?\)/g),
      ];
      for (const match of refs) {
        const target = match[1] || match[2];
        if (target === '/' || target === '/login') continue;
        await access(path.join('public', target)).catch(() => {
          throw new Error(`Missing local asset ${target} referenced by ${file}`);
        });
      }
    }
  }
}
await mkdir('public/vendor/markdown-it', { recursive: true });
await cp(
  'node_modules/markdown-it/dist/markdown-it.min.js',
  'public/vendor/markdown-it/markdown-it.min.js',
);
for (const dir of ['public', 'services', 'routes', 'middleware', 'api']) await check(dir);
for (const file of ['server.js', 'scripts/build.mjs']) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status) throw new Error(result.stderr);
}
const html = await readFile('public/index.html', 'utf8');
if (!html.includes('type="module"')) throw new Error('Missing app entry');
console.log('Build OK: JavaScript and local assets checked; Markdown bundle ready.');
