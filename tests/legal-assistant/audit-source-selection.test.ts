import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orderedAuditSources,privateAuditAttachment} from '../../src/lib/orchestrator/audit-source-selection.ts';
test('operative sources outrank incidental documents and prior audits cannot contaminate review',()=>{
 const items=['Z general correspondence.pdf','Signing package audit report.pdf','APS Amendment.pdf','Lender Instructions.pdf','Parcel Register.pdf'].map((name,i)=>({name,id:String(i),mimeType:'application/pdf'}));
 const names=orderedAuditSources(items).map(x=>x.name);
 assert.deepEqual(names,['APS Amendment.pdf','Lender Instructions.pdf','Parcel Register.pdf','Z general correspondence.pdf']);
 assert.deepEqual(orderedAuditSources([...items].reverse()),orderedAuditSources(items));
 assert.deepEqual(orderedAuditSources([{id:'a',name:'LOT_130_APS.pdf',mimeType:'application/pdf'},{id:'b',name:'Incidental note.pdf',mimeType:'application/pdf'}]).map(x=>x.id),['a','b']);
});
test('identity and banking filenames with separators are excluded from automatic supporting capture',()=>{
 for(const name of ['Client_ID.pdf','Kavan_driving_licence_.pdf','passport.pdf','client void.pdf','void-cheque.pdf'])assert.equal(privateAuditAttachment(name),true);
 for(const name of ['Title direction.pdf','Individual capacity declaration.pdf','Lender Instructions.pdf'])assert.equal(privateAuditAttachment(name),false);
});
