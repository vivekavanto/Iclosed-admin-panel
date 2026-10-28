import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const source = dirname(require.resolve('pdfjs-dist/package.json'));
const digest = (file:string) => createHash('sha256').update(readFileSync(file)).digest('hex');

test('PDF assets are generated from exactly the locked package, including worker and licenses', () => {
 execFileSync(process.execPath,['scripts/sync-pdfjs-assets.mjs']);
 const app=JSON.parse(readFileSync('package.json','utf8'));
 const installed=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
 const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
 assert.equal(app.dependencies['pdfjs-dist'],installed.version);
 assert.equal(lock.packages['node_modules/pdfjs-dist'].version,installed.version);
 function sameTree(input:string,output:string){
  for(const entry of readdirSync(input,{withFileTypes:true})){
   const src=join(input,entry.name),dst=join(output,entry.name);
   if(entry.isDirectory())sameTree(src,dst);else assert.equal(digest(dst),digest(src),dst);
  }
 }
 for(const name of ['pdf.mjs','pdf.worker.mjs'])assert.equal(digest(`public/vendor/pdfjs/${name}`),digest(join(source,'build',name)));
 for(const name of ['cmaps','standard_fonts','wasm'])sameTree(join(source,name),`public/vendor/pdfjs/${name}`);
 assert.equal(digest('public/vendor/pdfjs/LICENSE'),digest(join(source,'LICENSE')));
});
