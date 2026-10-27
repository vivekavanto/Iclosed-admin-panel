#!/usr/bin/env node
import {mkdir, readFile, writeFile, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--source') throw Error('Usage: node scripts/testing/refresh-sync-fixture.mjs --source /path/to/canonical-admin-checkout');
const source = await realpath(args[1]);
const directory = path.join(source, 'scripts/legal-assistant-local-sync');
const destination = path.join(repo, 'tests/fixtures/local-sync');
const names = ['sync.mjs', 'sync.test.mjs', 'closer-import.ts', 'closing-views.ts', 'google-drive.ts', 'google-extracts.ts', 'local-store.ts', 'model.ts', 'report-selection.ts', 'package.json'];
// Deliberately excludes run.mjs, private configuration, state and credential files.
const sha256 = {};
await mkdir(destination, {recursive: true});
for (const name of names) {
  const bytes = await readFile(path.join(directory, name));
  sha256[name] = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(destination, name), bytes);
}
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: source, encoding: 'utf8'});
if (revision.status !== 0) throw Error('Canonical checkout revision unavailable');
await writeFile(path.join(destination, 'source-manifest.json'), JSON.stringify({
  source: 'iclosed-admin/scripts/legal-assistant-local-sync', revision: revision.stdout.trim(), sha256,
  purpose: 'Unmodified synthetic test snapshot; never the scheduled runtime. Refresh with --source and review checksums.',
}, null, 2) + '\n');
console.log('Updated pinned synthetic sync fixture. Review diff and run npm run test:sync.');
