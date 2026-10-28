import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Generate same-origin browser assets from one locked package. Never copy from
// a workstation runtime or mix the main library and worker from different builds.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const source = dirname(require.resolve('pdfjs-dist/package.json'));
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (app.dependencies['pdfjs-dist'] !== pkg.version) {
  throw new Error('PDF.js must be pinned exactly and match the installed version. Run npm ci.');
}
const target = join(root, 'public/vendor/pdfjs');
// Validate every source before replacing the generated output.
const entries = ['build/pdf.mjs', 'build/pdf.worker.mjs', 'standard_fonts', 'cmaps', 'wasm', 'LICENSE'];
for (const entry of entries) await access(join(source, entry));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
// Copy the known package tree without fs.cp's ancestor stat walk, so the
// integrity test can run with filesystem reads confined to its disposable copy.
async function copyAsset(input, output) {
  const children = await readdir(input, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!children) return copyFile(input, output);
  await mkdir(output, { recursive: true });
  for (const child of children) {
    if (child.isSymbolicLink()) throw new Error('Unexpected symlink in PDF.js assets');
    await copyAsset(join(input, child.name), join(output, child.name));
  }
}
for (const entry of entries) {
  await copyAsset(join(source, entry), join(target, entry.replace(/^build\//, '')));
}
await writeFile(join(target, 'VERSION.txt'), `Mozilla PDF.js ${pkg.version}, Apache-2.0. Generated from locked pdfjs-dist.\n`);
console.log(`Prepared PDF.js ${pkg.version} browser assets.`);
