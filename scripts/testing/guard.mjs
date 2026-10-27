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

if (process.env.NODE_TEST_CONTEXT || process.env.ICLOSED_TEST_CHILD_GUARD) {
  const deny = () => { throw new Error('ICLOSED_TEST_SAFETY: real network/subprocess access is disabled; inject a mock provider'); };
  globalThis.fetch = async () => deny(); // Tests may replace fetch with their own mock.
  for (const [object, keys] of [
    [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']],
    [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']],
    [dgram, ['createSocket']], [dns, ['lookup', 'resolve']],
    [dns.promises, ['lookup', 'resolve']],
  ]) for (const key of keys) Object.defineProperty(object, key, {value: deny, writable: false, configurable: false});
  const execFileSync = child.execFileSync;
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
  syncBuiltinESMExports();
}
