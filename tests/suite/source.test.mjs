import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fingerprint} from '../../scripts/testing/source.mjs';
async function fixture(check) {
  const root=await mkdtemp(path.join(os.tmpdir(),'fingerprint-test-'));
  try {
    for(const dir of ['src','tests','scripts/testing','public']) await mkdir(path.join(root,dir),{recursive:true});
    for(const file of ['package.json','package-lock.json','scripts/sync-pdfjs-assets.mjs','public/email-logo.png']) await writeFile(path.join(root,file),'synthetic');
    await check(root);
  } finally {await rm(root,{recursive:true,force:true});}
}
test('source fingerprint binds uncommitted source changes while excluding result output',()=>fixture(async root=>{
  const before=await fingerprint(root);
  await mkdir(path.join(root,'test-results'));await writeFile(path.join(root,'test-results/result.json'),'ignored');
  assert.equal(await fingerprint(root),before);
  await writeFile(path.join(root,'src/changed.ts'),'new source');assert.notEqual(await fingerprint(root),before);
}));
test('permission sandbox refuses symlink creation that could expose private files',()=>fixture(async root=>{
  await assert.rejects(symlink('/etc/passwd',path.join(root,'tests/leak.txt')), {code:'ERR_ACCESS_DENIED'});
}));
