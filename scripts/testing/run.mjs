#!/usr/bin/env node
import {cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {fingerprint} from './source.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = process.argv.slice(2);
const suite = options.shift() || 'all';
if (!['all', 'legal-assistant', 'admin', 'sync', 'safety'].includes(suite) || options.length) {
  console.error('Usage: node scripts/testing/run.mjs [all|legal-assistant|admin|sync|safety]'); process.exit(2);
}
if (Number(process.versions.node.split('.')[0]) < 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 13)) {
  console.error('Use Node 22.13+ (Node permission model and TypeScript stripping required).'); process.exit(2);
}
const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'iclosed-tests-')));
const dependencies = await realpath(path.join(repo, 'node_modules'));
const startedAt = new Date().toISOString();
const runId = `${suite}-${randomUUID()}`;
const report = {schemaVersion: 1, suite, runId, classification: 'automated-synthetic', startedAt, node: process.version,
  sourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8'}).stdout.trim(),
  safety: {credentialsInherited: false, liveNetwork: false, privateStateAccessible: false, disposableState: true},
  components: [], status: 'failed'};
const hash = data => createHash('sha256').update(data).digest('hex');
async function filesBelow(dir) {
  const result = [];
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(full));
    else if (entry.isFile() && /\.test\.(ts|mjs)$/.test(entry.name)) result.push(full);
  }
  return result.sort();
}
async function execute(name, files) {
  const env = {
    PATH: path.dirname(process.execPath), HOME: path.join(scratch, 'home'),
    TMPDIR: path.join(scratch, 'tmp'), TMP: path.join(scratch, 'tmp'), TEMP: path.join(scratch, 'tmp'),
    NODE_ENV: 'test', TZ: 'America/Toronto', LANG: 'en_US.UTF-8',
    ORCHESTRATOR_LOCAL_STATE_DIR: path.join(scratch, 'state'),
    ICLOSED_TEST_ROOT: scratch, ICLOSED_TEST_DEPENDENCIES: dependencies,
  };
  const args = ['--permission', `--allow-fs-read=${scratch}`, `--allow-fs-read=${dependencies}`,
    `--allow-fs-write=${scratch}`, '--allow-child-process', '--experimental-strip-types',
    '--import', path.join(scratch, 'scripts/testing/guard.mjs'),
    '--test', '--test-reporter=tap', '--test-timeout=60000', ...files.map(file => path.relative(scratch, file))];
  const result = spawnSync(process.execPath, args, {cwd: scratch, env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024});
  const log = (result.stdout || '') + (result.stderr || '');
  const count = key => Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0);
  const summary = {name, status: result.status === 0 && !result.error && count('tests') > 0 && count('skipped') === 0 && count('todo') === 0 ? 'passed' : 'failed',
    tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), todo: count('todo'),
    files: files.map(file => path.relative(scratch, file)), log: `${runId}/${name}.tap`, logSha256: hash(log)};
  await writeFile(path.join(repo, 'test-results', summary.log), log, {mode: 0o600});
  report.components.push(summary);
  console.log(`${name}: ${summary.passed}/${summary.tests} passed; ${summary.failed} failed, ${summary.skipped} skipped, ${summary.todo} todo`);
  if (summary.status !== 'passed') console.error(log.slice(-16000), result.error?.message || '');
}
try {
  report.sourceFingerprint = await fingerprint(repo);
  // Positive allowlist: no .env, private configuration, cookies, reports or register copies.
  for (const name of ['src', 'tests']) await cp(path.join(repo, name), path.join(scratch, name), {recursive: true, filter: source => !path.basename(source).startsWith('.')});
  await mkdir(path.join(scratch, 'scripts'), {recursive: true});
  await cp(path.join(repo, 'scripts/testing'), path.join(scratch, 'scripts/testing'), {recursive: true});
  await cp(path.join(repo, 'scripts/sync-pdfjs-assets.mjs'), path.join(scratch, 'scripts/sync-pdfjs-assets.mjs'));
  await mkdir(path.join(scratch, 'public'), {recursive: true});
  await cp(path.join(repo, 'public/email-logo.png'), path.join(scratch, 'public/email-logo.png'));
  for (const name of ['package.json', 'package-lock.json']) await cp(path.join(repo, name), path.join(scratch, name));
  await mkdir(path.join(scratch, 'node_modules'));
  for (const entry of await readdir(dependencies, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const target = path.join(scratch, 'node_modules', entry.name);
    if (entry.name === 'pdfjs-dist') await cp(path.join(dependencies, entry.name), target, {recursive: true});
    else await symlink(path.join(dependencies, entry.name), target, entry.isDirectory() ? 'dir' : 'file');
  }
  for (const dir of ['tmp', 'home', 'state']) await mkdir(path.join(scratch, dir), {mode: 0o700});
  await mkdir(path.join(repo, 'test-results', runId), {recursive: true});
  const all = await filesBelow(path.join(scratch, 'tests'));
  if (['all', 'safety'].includes(suite)) await execute('safety', all.filter(file => file.includes('/suite/')));
  if (['all', 'legal-assistant'].includes(suite)) await execute('legal-assistant', all.filter(file => file.includes('/legal-assistant/')));
  if (['all', 'admin'].includes(suite)) await execute('admin', all.filter(file => !file.includes('/suite/') && !file.includes('/legal-assistant/') && !file.includes('/fixtures/')));
  if (['all', 'sync'].includes(suite)) {
    const manifest = JSON.parse(await readFile(path.join(repo, 'tests/fixtures/local-sync/source-manifest.json'), 'utf8'));
    for (const [name, digest] of Object.entries(manifest.sha256)) {
      if (hash(await readFile(path.join(repo, 'tests/fixtures/local-sync', name))) !== digest) throw Error(`Pinned sync fixture changed: ${name}; refresh from canonical checkout and review`);
    }
    report.syncSource = manifest;
    await execute('local-sync', await filesBelow(path.join(scratch, 'tests/fixtures/local-sync')));
  }
  if (await fingerprint(repo) !== report.sourceFingerprint) throw Error('Source changed during test run; rerun required');
  report.status = report.components.every(component => component.status === 'passed') ? 'passed' : 'failed';
} catch (error) { report.error = error.message; console.error(error.message); }
finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(repo, 'test-results'), {recursive: true});
  await writeFile(path.join(repo, 'test-results', `${suite}.json`), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  await rm(scratch, {recursive: true, force: true});
}
console.log(`Result: test-results/${suite}.json (${report.classification}; ${report.status})`);
process.exitCode = report.status === 'passed' ? 0 : 1;
