import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {decodeCooDraft,type CooDraft} from '../../src/lib/coo/model.ts';
import {storeCooReview,approveAndSendCoo,latestCooReview,cooDashboardSummaries} from '../../src/lib/coo/delivery-store.ts';
import {cooRegisterAction} from '../../src/lib/coo/delivery-model.ts';
let root:string;const original={...process.env};
beforeEach(async()=>{root=await mkdtemp(path.join(tmpdir(),'coo-delivery-'));process.env.ORCHESTRATOR_LOCAL_STATE_DIR=root;});
afterEach(async()=>{await rm(root,{recursive:true,force:true});for(const k of Object.keys(process.env))if(!(k in original))delete process.env[k];Object.assign(process.env,original);});
async function draft(){return decodeCooDraft(JSON.parse(await readFile(new URL('./fixtures/coo-demo.json',import.meta.url),'utf8')));}
function packets(d:CooDraft){return (['tax','water','condo']as const).filter(k=>d.recipients[k].enabled&&!(d.combineTaxWater&&k==='water')).map(department=>{const bytes=Buffer.from('%PDF-1.7 synthetic test '+department);return {department,filename:department+'.pdf',pdfBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),pages:2};});}
const approval=(r:Awaited<ReturnType<typeof storeCooReview>>)=>({id:r.id,hash:r.hash,fileId:r.fileId,actor:'reviewer',approved:true});
test('generation is durable Review, identical regeneration reuses its revision, and only receipted sends become Sent',async()=>{const d=await draft(),r=await storeCooReview(d,packets(d),'author');assert.equal(r.status,'review');assert.equal((await storeCooReview(d,packets(d),'author')).id,r.id);let calls=0;const send=async()=>({id:'receipt-'+ ++calls});const sent=await approveAndSendCoo(approval(r),send);assert.equal(sent.status,'sent');assert.equal(calls,3);assert.equal(sent.approval?.hash,r.hash);assert.equal((await latestCooReview(d.fileId))?.status,'sent');assert.equal((await cooDashboardSummaries())[d.fileId].status,'sent');await approveAndSendCoo(approval(r),send);assert.equal(calls,3);});
test('missing approval, wrong hashes and superseded revisions cannot send',async()=>{const d=await draft(),r=await storeCooReview(d,packets(d),'author');const send=async()=>{throw Error('Must not call provider');};await assert.rejects(approveAndSendCoo({...approval(r),approved:false},send),/approval/);await assert.rejects(approveAndSendCoo({...approval(r),hash:'wrong'},send),/revision/);d.cc='reviewed@example.test';await storeCooReview(d,packets(d),'author');await assert.rejects(approveAndSendCoo(approval(r),send),/revision/);});
test('ambiguous provider results block repeat sends and never claim Sent',async()=>{const d=await draft(),r=await storeCooReview(d,packets(d),'author');let calls=0;const send=async()=>{calls++;throw Error('timeout after possible acceptance');};await assert.rejects(approveAndSendCoo(approval(r),send),/reconciliation/);assert.equal((await latestCooReview(d.fileId))?.status,'uncertain');await assert.rejects(approveAndSendCoo(approval(r),send),/reconciliation/);assert.equal(calls,1);});
test('partial sends preserve receipts but leave the file for review',async()=>{const d=await draft(),r=await storeCooReview(d,packets(d),'author');let calls=0;await assert.rejects(approveAndSendCoo(approval(r),async()=>{if(++calls===2)throw Error('no receipt');return {id:'first'};}));const saved=await latestCooReview(d.fileId);assert.equal(saved?.receipts.tax.id,'first');assert.equal(saved?.status,'uncertain');assert.equal(calls,2);});
test('Mississauga is Client Only, including saved revisions, and cannot use firm sending',async()=>{const d=await draft();d.property='10 Example Road, Mississauga, ON';const r=await storeCooReview(d,packets(d),'author');assert.equal(cooRegisterAction(d.property,'purchase',r).label,'Client Only');await assert.rejects(approveAndSendCoo(approval(r),async()=>({id:'must-not-send'})),/client submission/);assert.equal(cooRegisterAction('10 Example Road, Toronto, ON','purchase').label,'Prepare COO');assert.equal(cooRegisterAction('10 Example Road, Toronto, ON','purchase',r).label,'Review');assert.equal(cooRegisterAction('10 Example Road, Toronto, ON','purchase',{...r,status:'sent'}).label,'Sent');});


test('editing a recipient, sender or PDF requires approval of a new revision',async()=>{
 for(const change of ['recipient','sender','pdf']){const d=await draft();d.fileId+='-'+change;const original=await storeCooReview(d,packets(d),'author');let next;
  if(change==='recipient'){d.recipients.tax.email='new-tax@example.test';next=await storeCooReview(d,packets(d),'author');}
  else if(change==='sender'){process.env.ORCHESTRATOR_COO_FROM='Changed Sender <changed@example.test>';next=await storeCooReview(d,packets(d),'author');delete process.env.ORCHESTRATOR_COO_FROM;}
  else{const updated=packets(d),bytes=Buffer.from('%PDF- revised synthetic tax notice');updated[0]={...updated[0],pdfBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};next=await storeCooReview(d,updated,'author');}
  assert.notEqual(next.hash,original.hash);let calls=0;await assert.rejects(approveAndSendCoo(approval(original),async()=>{calls++;return{id:'must-not-send'};}));assert.equal(calls,0);
 }
});
test('a revision changed during sending stops remaining old-revision messages',async()=>{
 const d=await draft(),r=await storeCooReview(d,packets(d),'author');let calls=0;
 await assert.rejects(approveAndSendCoo(approval(r),async()=>{calls++;if(calls===1){const changed=structuredClone(d);changed.cc='new-review@example.test';await storeCooReview(changed,packets(changed),'editor');}return{id:'receipt-'+calls};}));
 assert.equal(calls,1);assert.equal((await latestCooReview(d.fileId))!.status,'review');
});


test('tampered persisted recipients cannot be sent under the old reviewed hash',async()=>{
 const {writeFile}=await import('node:fs/promises');const d=await draft(),r=await storeCooReview(d,packets(d),'author');const disk=path.join(root,'coo',r.id+'.json');const changed=JSON.parse(await readFile(disk,'utf8'));changed.messages[0].to=['tampered@example.test'];await writeFile(disk,JSON.stringify(changed));let calls=0;await assert.rejects(approveAndSendCoo(approval(r),async()=>{calls++;return{id:'must-not-send'};}),/hash/);assert.equal(calls,0);
});
