// Loaded before each test process, never into the running application.
import {syncBuiltinESMExports} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import child from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';

if (process.env.NODE_TEST_CONTEXT || process.env.ICLOSED_TEST_CHILD_GUARD) {
  const deny = () => { throw new Error('ICLOSED_TEST_SAFETY: real network/subprocess access is disabled; inject a mock provider'); };
  globalThis.fetch = async () => deny(); // Tests may replace fetch with their own mock.
  for (const [object, keys] of [
    [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']],
    [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']],
    [dgram, ['createSocket']], [dns, ['lookup', 'resolve']],
    [dns.promises, ['lookup', 'resolve']],
  ]) for (const key of keys) Object.defineProperty(object, key, {value: deny, writable: false, configurable: false});
  const execFileSync = child.execFileSync, execFile = child.execFile;
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'fork']) child[key] = deny;
  // The existing asset integrity test has one reviewed local Node subprocess.
  // It receives the same filesystem restrictions and no ambient credentials.
  child.execFileSync = (command, args, options) => {
    if (command !== process.execPath || JSON.stringify(args) !== JSON.stringify(['scripts/sync-pdfjs-assets.mjs']) || options !== undefined) return deny();
    return execFileSync(command, [
      '--permission', `--allow-fs-read=${process.env.ICLOSED_TEST_ROOT}`,
      `--allow-fs-read=${process.env.ICLOSED_TEST_DEPENDENCIES}`,
      `--allow-fs-write=${process.env.ICLOSED_TEST_ROOT}`,
      '--import', path.join(process.env.ICLOSED_TEST_ROOT, 'scripts/testing/guard.mjs'), ...args,
    ], {cwd: process.cwd(), env: {...process.env, ICLOSED_TEST_CHILD_GUARD: '1'}});
  };
  // Hosted-transfer regression subprocesses stay inside disposable state and
  // inherit the same network, filesystem and credential restrictions.
  child.execFile = (command, args, callback) => {
    const root = process.env.ICLOSED_TEST_ROOT;
    const script = path.join(root, 'scripts/legal-assistant-hosted/transfer.mjs');
    if (command !== process.execPath || args?.[0] !== script || typeof callback !== 'function') return deny();
    const flags = new Set(['--source', '--manifest', '--apply', '--expected-manifest']);
    for (let i = 1; i < args.length; i++) {
      const flag = args[i]; if (!flags.has(flag)) return deny();
      if (flag === '--apply') continue;
      const value = args[++i];
      if (typeof value !== 'string') return deny();
      if (flag === '--expected-manifest') { if (!/^[a-f0-9]{64}$/.test(value)) return deny(); }
      else if (!path.resolve(value).startsWith(root + path.sep)) return deny();
    }
    return execFile(command, ['--permission', `--allow-fs-read=${root}`,
      `--allow-fs-read=${process.env.ICLOSED_TEST_DEPENDENCIES}`, `--allow-fs-write=${root}`,
      '--experimental-strip-types', '--import', path.join(root, 'scripts/testing/guard.mjs'), ...args],
      {cwd: root, env: {...process.env, ICLOSED_TEST_CHILD_GUARD: '1'}}, callback);
  };
  child.execFile[promisify.custom] = (command, args) => new Promise((resolve, reject) => {
    child.execFile(command, args, (error, stdout, stderr) => error ? reject(error) : resolve({stdout, stderr}));
  });
  syncBuiltinESMExports();
}
