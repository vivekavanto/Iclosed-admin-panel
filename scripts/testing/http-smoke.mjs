#!/usr/bin/env node
// Explicit, anonymous, read-only integration check; never part of npm test.
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fingerprint} from './source.mjs';
import {fileURLToPath} from 'node:url';
if (process.argv.length !== 2) throw Error('This check only supports the canonical local origin; no tokens, cookies or arbitrary URLs accepted');
const origin = 'http://127.0.0.1:3004';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const report = {classification:'read-only-integration', startedAt:new Date().toISOString(), origin, authenticated:false, sourceFingerprint:await fingerprint(repo), checks:[], status:'failed'};
for (const route of ['/api/admin/legal-assistant/file-opening/inbox', '/api/admin/legal-assistant/audits/status']) {
  try {
    const response = await fetch(origin + route, {redirect:'manual', signal:AbortSignal.timeout(15000), headers:{Accept:'application/json'}});
    await response.body?.cancel();
    report.checks.push({route, status:response.status, result:response.status === 401 ? 'passed' : 'failed'});
  } catch (error) { report.checks.push({route, result:'blocked', reason:error.cause?.code || error.name}); }
}
report.status = report.checks.some(c => c.result === 'failed') ? 'failed' : report.checks.some(c => c.result === 'blocked') ? 'blocked' : 'passed';
await mkdir(path.join(repo, 'test-results'), {recursive:true});
await writeFile(path.join(repo, 'test-results/http-smoke.json'), JSON.stringify(report,null,2)+'\n', {mode:0o600});
console.log(JSON.stringify(report,null,2));
process.exitCode = report.status === 'passed' ? 0 : 1;
