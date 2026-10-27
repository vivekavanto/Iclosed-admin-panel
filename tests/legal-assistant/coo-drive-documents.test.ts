import test from 'node:test';
import assert from 'node:assert/strict';
import {cooDocumentKind} from '../../src/lib/coo/drive-documents.ts';
test('existing notice metadata is distinct from unverified deed candidates',()=>{
  assert.equal(cooDocumentKind('26P-0901 COO Tax Notice and Registered Transfer AB12345.pdf'),'notice');
  assert.equal(cooDocumentKind('Ownership Notice.pdf',true),'notice');
  assert.equal(cooDocumentKind('Transfer AB12345.pdf'),'transfer');
  assert.equal(cooDocumentKind('Deed.pdf'),'transfer');
  assert.equal(cooDocumentKind('Deed.pdf',true),'transfer');
  assert.equal(cooDocumentKind('Prescribed Information for Purposes of Section 5 Land Transfer Tax Act.pdf'),null);
  assert.equal(cooDocumentKind('TRANSFER IN PREP.pdf'),null);
  assert.equal(cooDocumentKind('Draft COO Notice.pdf',true),null);
});

test('Drive attachment is confined to the verified property and excludes in-preparation transfers',async()=>{
 const {attachCooTransfer}=await import('../../src/lib/coo/drive-documents.ts');
 const deed={id:'deed',name:'Deed.pdf',mimeType:'application/pdf',size:'12',modifiedTime:'2026-10-26T00:00:00Z',parents:['root']};let downloads=0;
 const reader={children:async()=>[deed,{...deed,id:'prep',name:'TRANSFER IN PREP.pdf'}],metadata:async()=>deed,pdf:async()=>{downloads++;return Buffer.from('%PDF-source');}};
 assert.equal((await attachCooTransfer('root','deed',reader)).name,'Deed.pdf');
 await assert.rejects(attachCooTransfer('root','foreign',reader));
 await assert.rejects(attachCooTransfer('root','prep',reader));
 assert.equal(downloads,1);
 await assert.rejects(attachCooTransfer('root','deed',{...reader,metadata:async()=>({...deed,parents:['other']})}));
 let reads=0;await assert.rejects(attachCooTransfer('root','deed',{...reader,metadata:async()=>({...deed,modifiedTime:String(reads++)})}));
});
