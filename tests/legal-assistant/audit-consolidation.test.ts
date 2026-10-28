import{test}from'node:test';import assert from'node:assert/strict';import{auditConsolidationEvidence}from'../../src/lib/orchestrator/audit-consolidation.ts';import type{AuditManifest,AuditCandidate}from'../../src/lib/orchestrator/audit-model.ts';
test('large evidence synthesis retains exact cited spans without changing frozen sources',()=>{
 const text='Header '+ 'earlier context '.repeat(45000)+'Confirmed extension terms and deposit receipt'+' later context'.repeat(20000);
 const m={matterId:'t',matterNumber:'26S-0001',sources:[{id:'mail',kind:'email',pages:[{number:1,text,rendered:false,inkRatio:null}]}],limitations:[]} as unknown as AuditManifest;
 const original=JSON.stringify(m),finding={evidence:[{sourceId:'mail',page:1,quote:'Confirmed extension terms and deposit receipt'}]} as AuditCandidate;
 const result=auditConsolidationEvidence(m,[finding]);assert.equal(result.compacted,true);assert.match(result.manifest.sources[0].pages[0].text,/Confirmed extension terms and deposit receipt/);assert.equal(JSON.stringify(m),original);assert.ok(JSON.stringify(result.manifest).length<4000);assert.match(result.manifest.limitations.at(-1)!,/excerpts/);
});
test('small evidence retains full context',()=>{const m={sources:[],limitations:[]} as unknown as AuditManifest;assert.equal(auditConsolidationEvidence(m,[]).manifest,m);});
