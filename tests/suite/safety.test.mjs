import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import {spawnSync, execFileSync} from 'node:child_process';

test('ambient credentials, Node injection flags and live configuration are absent', () => {
  for (const key of Object.keys(process.env)) {
    if (/SECRET|TOKEN|PASSWORD|API_KEY|SERVICE_ROLE|NODE_OPTIONS|GOOGLE_APPLICATION_CREDENTIALS|PRIVATE_CONFIG/.test(key)) assert.fail(`Unexpected environment key: ${key}`);
  }
  assert.equal(process.env.NODE_ENV, 'test');
  assert.ok(process.env.ORCHESTRATOR_LOCAL_STATE_DIR.startsWith(process.env.ICLOSED_TEST_ROOT));
});
test('permission model denies private paths, repository environment and writes outside scratch', async () => {
  assert.ok(process.permission);
  for (const file of ['/etc/passwd', '/Users/saru/Library/Application Support/iClosed/LegalAssistant/private/state/state.json', '/Users/saru/Library/Application Support/iClosed/LegalAssistant/admin/.env.local']) {
    assert.equal(process.permission.has('fs.read', file), false);
    await assert.rejects(readFile(file), {code: 'ERR_ACCESS_DENIED'});
  }
  await assert.rejects(writeFile(path.join(process.cwd(), '..', 'must-not-write'), 'x'), {code: 'ERR_ACCESS_DENIED'});
});
test('real fetch, sockets, TLS, HTTPS and arbitrary subprocesses fail closed', async () => {
  await assert.rejects(fetch('https://example.test'), /ICLOSED_TEST_SAFETY/);
  for (const call of [() => net.connect(443, 'example.test'), () => tls.connect(443, 'example.test'), () => https.get('https://example.test'), () => spawnSync('echo', ['unsafe']), () => execFileSync(process.execPath, ['-e', 'process.exit(0)'])]) assert.throws(call, /ICLOSED_TEST_SAFETY/);
});
test('synthetic temporary state is writable and disposable without a business baseline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'suite-fixture-'));
  try { await writeFile(path.join(dir, 'synthetic.json'), '{"synthetic":true}'); assert.equal(await readFile(path.join(dir, 'synthetic.json'), 'utf8'), '{"synthetic":true}'); }
  finally { await rm(dir, {recursive: true, force: true}); }
});
