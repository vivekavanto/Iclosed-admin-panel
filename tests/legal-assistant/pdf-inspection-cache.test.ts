import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readPdfInspection,savePdfInspection} from '../../src/lib/orchestrator/pdf-inspection-cache.ts';
test('inspection reuse is bound to exact PDF bytes and OCR runtime; failed inspection is never cached',async()=>{
 const original={...process.env},root=await mkdtemp(path.join(tmpdir(),'pdf-inspection-cache-'));
 process.env.NODE_ENV='test';process.env.ORCHESTRATOR_LOCAL_STATE_DIR=root;
 const bytes=Buffer.from('%PDF- synthetic frozen source'),result={pages:[{number:1,text:'Readable source text',rendered:true,inkRatio:.1}],limitations:[]};
 try{
  assert.equal(await savePdfInspection(bytes,result),true);assert.deepEqual(await readPdfInspection(bytes),result);
  assert.equal(await readPdfInspection(Buffer.from('%PDF- different source')),null);
  process.env.ORCHESTRATOR_AUDIT_OCR='/different/runtime';assert.equal(await readPdfInspection(bytes),null);delete process.env.ORCHESTRATOR_AUDIT_OCR;
  assert.equal(await savePdfInspection(bytes,{...result,limitations:['Local OCR failed for one or more scanned pages.']}),false);
  assert.equal(await savePdfInspection(bytes,{...result,pages:[{...result.pages[0],rendered:false}]}),false);
  assert.equal(await savePdfInspection(bytes,{...result,pages:[{...result.pages[0],number:2}]}),false);
 }finally{for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);await rm(root,{recursive:true,force:true});}
});
