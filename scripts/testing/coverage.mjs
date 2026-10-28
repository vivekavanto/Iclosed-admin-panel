#!/usr/bin/env node
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {fingerprint} from './source.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--results' || !/^[a-z-]+\.json$/.test(args[1]))) throw Error('Usage: node scripts/testing/coverage.mjs [--results all.json]');
const matrix = JSON.parse(await readFile(path.join(repo, 'tests/coverage-matrix.json'), 'utf8'));
const result = args.length ? JSON.parse(await readFile(path.join(repo, 'test-results', args[1]), 'utf8')) : null;
if (result && result.sourceFingerprint !== await fingerprint(repo)) throw Error('Test evidence is stale for these sources; rerun the suite');
const ids = new Set();
const rows = [];
for (const row of matrix.rows) {
  if (ids.has(row.id)) throw Error(`Duplicate coverage ID ${row.id}`);
  ids.add(row.id);
  if (row.layer === 'automated-synthetic') {
    if (row.status !== 'mapped' || !row.evidence?.length) throw Error(`Missing evidence: ${row.id}`);
    let verified = !!result;
    for (const evidence of row.evidence) {
      if (!/^tests\/[\w/.-]+\.test\.(ts|mjs)$/.test(evidence.file) || evidence.file.includes('..')) throw Error('Unsafe evidence path');
      const source = await readFile(path.join(repo, evidence.file), 'utf8');
      const names = [...source.matchAll(/test\(\s*(['"])(.*?)\1/g)].map(match => match[2]);
      if (!evidence.selectors?.length) throw Error(`Missing selectors: ${row.id}`);
      const component = result?.components.find(component => component.files.includes(evidence.file));
      const log = component ? await readFile(path.join(repo, 'test-results', component.log), 'utf8') : '';
      if (component && createHash('sha256').update(log).digest('hex') !== component.logSha256) throw Error('Test log changed after result was recorded');
      const passed = new Set(log.split('\n').filter(line => /^\s*ok \d+ - /.test(line) && !/# (SKIP|TODO)/i.test(line)).map(line => line.replace(/^\s*ok \d+ - /, '').trim()));
      for (const selector of evidence.selectors) {
        const selected = names.filter(name => name.startsWith(selector));
        if (selected.length !== 1) throw Error(`${row.id}: selector must match exactly one test: ${selector}`);
        if (!passed.has(selected[0]) || component?.status !== 'passed') verified = false;
      }
    }
    rows.push({...row, status: result ? (verified ? 'passed-synthetic' : 'unverified') : 'mapped-not-run'});
  } else {
    if (!row.reason || !row.next || !['blocked', 'not-run'].includes(row.status)) throw Error(`Missing coverage gate: ${row.id}`);
    if (row.resultFile && result) {
      if (!/^[a-z-]+\.json$/.test(row.resultFile)) throw Error('Unsafe result path');
      const external = await readFile(path.join(repo, 'test-results', row.resultFile), 'utf8').then(JSON.parse).catch(() => null);
      if (external?.sourceFingerprint === result.sourceFingerprint && external.classification === row.layer) {
        const status = external.status === 'passed' ? (row.layer === 'read-only-integration' ? 'passed-read-only' : 'passed-signed-in-ui') : external.status;
        rows.push({...row, status, checkedAt:external.startedAt});
        continue;
      }
    }
    rows.push(row);
  }
}
const summary = {schemaVersion:1, generatedAt:new Date().toISOString(), evidenceRun: result?.startedAt || null, scope:'Scenario inventory; no live delivery, AI quality or line-coverage claim', rows};
await mkdir(path.join(repo, 'test-results'), {recursive:true});
await writeFile(path.join(repo, 'test-results/coverage.json'), JSON.stringify(summary,null,2)+'\n');
const clean = text => String(text || '').replaceAll('|','/').replaceAll('\n',' ');
const markdown = '# iClosed scenario coverage\n\n'+summary.scope+'\n\n| ID | Layer | Status | Scenario | Evidence / limitation / next action |\n| --- | --- | --- | --- | --- |\n'+rows.map(row => `| ${row.id} | ${row.layer} | ${row.status} | ${clean(row.scenario)} | ${clean(row.evidence?.map(e => e.file).join(', '))} ${clean(row.limitation || row.reason)} ${clean(row.next)} |`).join('\n')+'\n';
await writeFile(path.join(repo, 'test-results/coverage.md'), markdown);
const counts = Object.fromEntries([...new Set(rows.map(row=>row.status))].map(status => [status,rows.filter(row=>row.status===status).length]));
console.log(JSON.stringify(counts));
console.log('Validated coverage: test-results/coverage.md');
if (result && rows.some(row=>row.status==='unverified')) process.exitCode=1;
