import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditReviewPasses} from '../../src/lib/orchestrator/audit-review-passes.ts';
import type {AuditManifest} from '../../src/lib/orchestrator/audit-model.ts';
test('large matters keep their exact package and every support source across bounded review passes',()=>{
 const source=(id:string,kind:'package'|'support',n:number)=>({id,name:id,kind,sha256:'a'.repeat(64),capturedAt:'2026-10-26',pages:Array.from({length:n},(_,i)=>({number:i+1,text:'Example page text',rendered:true,inkRatio:.1}))});
 const m:AuditManifest={matterId:'test',matterNumber:'26P-0001',cutoff:'2026-10-26',packageHash:'a'.repeat(64),ruleset:'test',limitations:[],sources:[source('package','package',104),...Array.from({length:24},(_,i)=>source('support-'+i,'support',5))]};
 const passes=auditReviewPasses(m);assert.ok(passes.length>1);assert.ok(passes.every(p=>p.sources[0]===m.sources[0]));assert.deepEqual(passes.flatMap(p=>p.sources.slice(1).map(s=>s.id)),m.sources.slice(1).map(s=>s.id));assert.ok(passes.every(p=>p.sources.length<=9));assert.equal(auditReviewPasses({...m,sources:m.sources.slice(0,3)}).length,1);
});
