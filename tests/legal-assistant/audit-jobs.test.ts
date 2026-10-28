import {test,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {AUDIT_RULESET,digest,reconcileAudit,validateCandidate,type AuditCandidate,type AuditJob,type AuditManifest} from "../../src/lib/orchestrator/audit-model.ts";
import {auditSnapshot,enqueueAudit,claimAudit,checkpointAudit,finishAudit,updateAuditDisposition,putAuditBlob,auditDirectory} from "../../src/lib/orchestrator/audit-store.ts";
import {parseAuditReview,OpenAIAuditReviewer} from "../../src/lib/orchestrator/audit-openai.ts";
import {runAuditWorker} from "../../src/lib/orchestrator/audit-worker.ts";
let directory:string;const original={...process.env};
const bytes=Buffer.from('%PDF-1.7\nsynthetic test bytes, not a legal document');
const candidate:AuditCandidate={key:"payment-date",kind:"discrepancy",summary:"Payment dates differ",action:"Ask lender to confirm the schedule",proposedBlocker:true,claim:"text",evidence:[{sourceId:"pdf",page:1,quote:"First payment November 1"}]};
const input=()=>({matterId:"matter-a",matterNumber:"26P-0612",folderId:"folder-a",packageId:"pdf",packageName:"test.pdf",packageHash:digest(bytes),actor:"staff-a",ruleset:AUDIT_RULESET,requestId:randomUUID()});
const manifest=(job:AuditJob):AuditManifest=>({matterId:job.matterId,matterNumber:job.matterNumber,packageHash:job.packageHash,cutoff:job.cutoff,ruleset:job.ruleset,limitations:[],sources:[{id:"pdf",name:"Test package",kind:"package",sha256:job.packageHash,capturedAt:job.cutoff,pages:[{number:1,text:"First payment November 1",rendered:true,inkRatio:.1}]}]});
beforeEach(async()=>{directory=await mkdtemp(path.join(tmpdir(),'audit-jobs-'));process.env.ORCHESTRATOR_LOCAL_STATE_DIR=directory;process.env.NODE_ENV="test";});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);});
async function complete(){const {job}=await enqueueAudit(input());const claimed=(await claimAudit())!;await checkpointAudit(job.id,claimed.lease!,manifest(job));return {job,report:await finishAudit(job.id,claimed.lease!,{findings:[candidate],resolutions:[],coverage:[]})};}
test("concurrent clicks create one durable job and retries reuse it after restart",async()=>{const request=input();const outcomes=await Promise.all(Array.from({length:12},(_,i)=>enqueueAudit({...request,requestId:i?randomUUID():request.requestId})));assert.equal(new Set(outcomes.map(x=>x.job.id)).size,1);assert.equal((await auditSnapshot(request.matterId)).jobs.length,1);assert.equal((await enqueueAudit(request)).duplicate,true);await assert.rejects(enqueueAudit({...request,packageHash:'b'.repeat(64)}));});
test("completed content is deduplicated; a new run requires explicit latest-job confirmation",async()=>{const {job}=await complete();assert.equal((await enqueueAudit(input())).duplicate,true);await assert.rejects(enqueueAudit({...input(),rerunOf:randomUUID()}));assert.equal((await enqueueAudit({...input(),rerunOf:job.id})).duplicate,false);});
test("rerun completion preserves concurrent clerk notes and stable finding IDs",async()=>{const {job,report}=await complete();await enqueueAudit({...input(),rerunOf:job.id});const claimed=(await claimAudit())!;await checkpointAudit(claimed.id,claimed.lease!,manifest(claimed));await updateAuditDisposition(job.matterId,report.findings[0].id,report.revision,"Incorrectly flagged","Lender confirmed this is intentional.");const next=await finishAudit(claimed.id,claimed.lease!,{findings:[candidate],resolutions:[],coverage:[]});assert.equal(next.findings[0].id,report.findings[0].id);assert.equal(next.findings[0].notes,"Lender confirmed this is intentional.");assert.equal(next.findings[0].disposition,"Incorrectly flagged");assert.equal(next.findings[0].proposedBlocker,false);assert.equal(next.history.length,2);});
test("omitted findings stay unable to reassess; invented resolution evidence is rejected",async()=>{const {job,report}=await complete();const next=reconcileAudit(report,job,manifest(job),{findings:[],resolutions:[{key:candidate.key,evidence:[{sourceId:'missing',page:1,quote:'it was corrected'}]}],coverage:[]});assert.equal(next.findings[0].movement,"Unable to reassess");assert.equal(next.findings[0].disposition,"Open");});
test("stale feedback and wrong source manifests fail without overwriting report",async()=>{const {job,report}=await complete();await updateAuditDisposition(job.matterId,'F-001',report.revision,'Needs lawyer review','Check schedule');await assert.rejects(updateAuditDisposition(job.matterId,'F-001',report.revision,'Open','overwrite'));const queued=await enqueueAudit({...input(),rerunOf:job.id});const claimed=(await claimAudit())!;await assert.rejects(checkpointAudit(queued.job.id,claimed.lease!,{...manifest(queued.job),matterId:'other-matter'}));assert.equal((await auditSnapshot(job.matterId)).report!.findings[0].notes,'Check schedule');});
test("nonblank or unrendered pages and missing receipts cannot become signing blockers",()=>{const job={...input(),cutoff:new Date().toISOString()} as AuditJob;for(const c of [{...candidate,claim:'blank_page' as const},{...candidate,claim:'missing_evidence' as const},{...candidate,evidence:[{sourceId:'pdf',page:1,quote:'made-up incorrect date'}]}]){const f=validateCandidate(c,manifest(job));assert.equal(f.kind,'unable_to_assess');assert.equal(f.proposedBlocker,false);}const m=manifest(job);m.sources[0].pages[0].rendered=false;assert.equal(validateCandidate(candidate,m).proposedBlocker,false);});
test("worker failures retain previous reports; expired worker cannot publish",async()=>{const {job,report}=await complete();await enqueueAudit({...input(),rerunOf:job.id});const result=await runAuditWorker({review:async()=>{throw new Error('provider secret must never be persisted');}},async j=>manifest(j));assert.equal(result.status,'failed');assert.equal((await auditSnapshot(job.matterId)).report!.revision,report.revision);const statePath=path.join(auditDirectory(),'jobs.json');const s=JSON.parse(await readFile(statePath,'utf8'));assert.ok(!JSON.stringify(s).includes('provider secret'));await enqueueAudit({...input(),rerunOf:s.jobs.at(-1).id});const claimed=(await claimAudit())!;const disk=JSON.parse(await readFile(statePath,'utf8'));disk.jobs.at(-1).leaseUntil='2000-01-01T00:00:00Z';await writeFile(statePath,JSON.stringify(disk));await assert.rejects(checkpointAudit(claimed.id,claimed.lease!,manifest(claimed)));assert.equal((await auditSnapshot(job.matterId)).jobs.at(-1)!.status,'failed');});
test("malformed or oversized reviewer responses fail closed",()=>{assert.throws(()=>parseAuditReview({findings:[{...candidate,kind:'legal_approval'}],resolutions:[],coverage:[]}));assert.throws(()=>parseAuditReview({findings:[{...candidate,evidence:[{sourceId:'pdf',page:0,quote:'bad page'}]}],resolutions:[],coverage:[]}));});
test("per-diem and existing tax reserve arithmetic are questions rather than false blockers",()=>{
 const job={...input(),cutoff:new Date().toISOString()} as AuditJob,m=manifest(job);
 const quote='Payout $826,765.09; ledger $826,851.59; per diem $86.50. Tax reserve $12,022.27.';
 m.sources[0].pages[0].text=quote;
 for(const financial of [{type:'per_diem' as const,baseCents:82676509,comparedCents:82685159,adjustmentCents:8650},{type:'tax_reserve' as const,baseCents:1202227,comparedCents:1202227,adjustmentCents:0}]){
  const f=validateCandidate({...candidate,evidence:[{sourceId:'pdf',page:1,quote}],financial},m);assert.equal(f.kind,'question');assert.equal(f.proposedBlocker,false);
 }
 const invalid=validateCandidate({...candidate,evidence:[{sourceId:'pdf',page:1,quote}],financial:{type:'per_diem',baseCents:1,comparedCents:2,adjustmentCents:1}},m);assert.equal(invalid.kind,'unable_to_assess');
});
test("shadow worker completes a queued job and a corrected-source rerun retains feedback",async()=>{
 await putAuditBlob(bytes);const first=await enqueueAudit(input());
 const reviewer={review:async()=>({findings:[candidate],resolutions:[],coverage:['Synthetic end-to-end test; not a live model evaluation.']})};
 assert.equal((await runAuditWorker(reviewer,async j=>manifest(j))).status,'completed');
 const originalReport=(await auditSnapshot(first.job.matterId)).report!;
 await updateAuditDisposition(first.job.matterId,'F-001',originalReport.revision,'Implemented','Clerk obtained correction','staff-a');
 const nextInput=input();nextInput.packageHash=digest('changed synthetic source');
 await enqueueAudit({...nextInput,rerunOf:first.job.id});
 const resolving={review:async()=>({findings:[],resolutions:[{key:candidate.key,evidence:[{sourceId:'pdf',page:1,quote:'First payment November 12'}]}],coverage:[]})};
 assert.equal((await runAuditWorker(resolving,async j=>{const m=manifest(j);m.sources[0].pages[0].text='First payment November 12';return m;})).status,'completed');
 const final=(await auditSnapshot(first.job.matterId)).report!;
 assert.equal(final.findings[0].movement,'Resolved');assert.equal(final.findings[0].disposition,'Implemented');assert.equal(final.findings[0].notes,'Clerk obtained correction');assert.equal(final.feedbackHistory![0].actor,'staff-a');assert.equal(final.history.length,2);assert.equal(final.findings[0].resolutionEvidence!.evidence[0].quote,'First payment November 12');
});
test("OpenAI adapter uses scoped frozen PDF, no response storage, strict schema, no tools", async () => {
  await putAuditBlob(bytes);
  const {addReportComment,reviewReportComment}=await import('../../src/lib/orchestrator/workflow-settings.ts');
  const feedback=await addReportComment('matter-a',1,'The clerk has explained the scheduled payout timing.','staff','clerk@example.com');
  await reviewReportComment(feedback.id,'approved','pending','Verified for this file.','reviewer','owner@example.com');
  await addReportComment('matter-a',1,'Pending instruction must not be used.','staff','clerk@example.com');
  const declined=await addReportComment('matter-a',1,'Declined instruction must not be used.','staff','clerk@example.com');
  await reviewReportComment(declined.id,'declined','pending','Not accepted.','reviewer','owner@example.com');
  await addReportComment('other-matter',1,'Unrelated private comment must not leak.','staff','other@example.com');
  process.env.ORCHESTRATOR_AUDIT_OPENAI_KEY = 'synthetic-test-key';
  process.env.ORCHESTRATOR_AUDIT_MODEL = 'test-model';
  process.env.ORCHESTRATOR_AUDIT_PYTHON = '/test/python';
  process.env.ORCHESTRATOR_AUDIT_SHADOW_ENABLED = 'true';
  const saved = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (url, init) => {
    called = true;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init!.body));
    assert.equal(body.store, false);
    assert.ok(!JSON.stringify(body).includes("Pending instruction must not be used."));
    assert.ok(!JSON.stringify(body).includes("Declined instruction must not be used."));
    assert.equal(body.text.format.strict, true);
    assert.equal(body.tools, undefined);
    assert.equal(body.input[0].content[2].type, 'input_file');
    const payload=JSON.parse(body.input[0].content[0].text);
    assert.equal(payload.clerkContext.length,1);
    assert.equal(payload.clerkContext[0].comment,'The clerk has explained the scheduled payout timing.');
    assert.equal(JSON.stringify(payload).includes('Unrelated private comment'),false);
    assert.equal(JSON.stringify(payload).includes('clerk@example.com'),false);
    const text = JSON.stringify({ findings: [candidate], resolutions: [], coverage: [] });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }));
  };
  try {
    const job = { ...input(), cutoff: new Date().toISOString() } as AuditJob;
    assert.equal((await new OpenAIAuditReviewer().review(manifest(job))).findings.length, 1);
    assert.equal(called, true);
  } finally { globalThis.fetch = saved; }
});

test('quota failures retain safe actionable diagnostics and preserve the report',async()=>{
 const {AuditFailure}=await import('../../src/lib/orchestrator/audit-failure.ts');
 const {job,report}=await complete();await enqueueAudit({...input(),rerunOf:job.id});
 const result=await runAuditWorker({review:async()=>{throw new AuditFailure({code:'credit_balance_exhausted',httpStatus:429,requestId:'req_test'});}},async j=>manifest(j));
 assert.equal(result.status,'failed');
 const snapshot=await auditSnapshot(job.matterId),failed=snapshot.jobs.at(-1)!;
 assert.equal(failed.failure?.stage,'review');assert.equal(failed.failure?.code,'credit_balance_exhausted');
 assert.match(failed.error!,/credit balance is exhausted/);assert.equal(snapshot.report!.revision,report.revision);
});
test('provider error bodies never enter job state or connection status',async()=>{
 await putAuditBlob(bytes);
 Object.assign(process.env,{ORCHESTRATOR_AUDIT_OPENAI_KEY:'synthetic',ORCHESTRATOR_AUDIT_MODEL:'test-model',ORCHESTRATOR_AUDIT_PYTHON:'/test/python',ORCHESTRATOR_AUDIT_SHADOW_ENABLED:'true'});
 const saved=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'credit_balance_exhausted',type:'insufficient_quota',message:'PRIVATE TEST DATA MUST NOT LEAK'}}),{status:429,headers:{'x-request-id':'req_test'}});
 try{await enqueueAudit(input());const result=await runAuditWorker(new OpenAIAuditReviewer(),async j=>manifest(j));assert.equal(result.status,'failed');
 const jobs=await readFile(path.join(auditDirectory(),'jobs.json'),'utf8'),health=await readFile(path.join(auditDirectory(),'provider-status.json'),'utf8');
 assert.equal((jobs+health).includes('PRIVATE TEST DATA'),false);assert.match(jobs,/credit_balance_exhausted/);
 }finally{globalThis.fetch=saved;}
});

test('large reviews visually inspect the package once, cover every supporting PDF and consolidate all text',async()=>{
 await putAuditBlob(bytes);Object.assign(process.env,{ORCHESTRATOR_AUDIT_OPENAI_KEY:'synthetic',ORCHESTRATOR_AUDIT_MODEL:'test-model',ORCHESTRATOR_AUDIT_PYTHON:'/test/python',ORCHESTRATOR_AUDIT_SHADOW_ENABLED:'true'});
 const m=manifest({...input(),cutoff:new Date().toISOString()}as AuditJob);
 m.sources.push(...Array.from({length:24},(_,i)=>({...m.sources[0],id:'support-'+i,kind:'support' as const,name:'Supporting document '+i,pages:Array.from({length:10},(_,number)=>({...m.sources[0].pages[0],number:number+1}))})));
 const saved=globalThis.fetch,bodies:{input:{content:{type:string;filename?:string;text?:string}[]}[]}[]=[];let progress=0;
 globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(String(init!.body)));return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({findings:[],resolutions:[],coverage:[]})}]}]}));};
 try{await new OpenAIAuditReviewer().review(m,async()=>{progress++;});assert.equal(bodies.length,4);assert.equal(progress,4);assert.equal(bodies.flatMap(b=>b.input[0].content).filter(c=>c.filename==='submitted-signing-package.pdf').length,1);assert.equal(bodies.slice(0,-1).flatMap(b=>b.input[0].content).filter(c=>c.type==='input_file').length,25);assert.equal(bodies.at(-1)!.input[0].content.some(c=>c.type==='input_file'),false);assert.equal(JSON.parse(bodies.at(-1)!.input[0].content[0].text!).manifest.sources.length,25);}finally{globalThis.fetch=saved;}
});

test('staged progress is durable and rejects an incorrect lease or invalid step',async()=>{
 const {recordAuditReviewProgress}=await import('../../src/lib/orchestrator/audit-store.ts');
 const {job}=await enqueueAudit(input());const claimed=(await claimAudit())!;
 await checkpointAudit(job.id,claimed.lease!,manifest(job));
 await recordAuditReviewProgress(job.id,claimed.lease!,{step:2,total:4,phase:'source_review'});
 assert.deepEqual((await auditSnapshot(job.matterId)).jobs[0].reviewProgress,{step:2,total:4,phase:'source_review'});
 await assert.rejects(recordAuditReviewProgress(job.id,'wrong',{step:3,total:4,phase:'source_review'}));
 await assert.rejects(recordAuditReviewProgress(job.id,claimed.lease!,{step:5,total:4,phase:'consolidation'}));
});

test('consolidation retains native PDFs for pages whose OCR text is unusable',async()=>{
 process.env.ORCHESTRATOR_AUDIT_OPENAI_KEY='synthetic-test-key';process.env.ORCHESTRATOR_AUDIT_MODEL='test-model';process.env.ORCHESTRATOR_AUDIT_PYTHON='/test/python';process.env.ORCHESTRATOR_AUDIT_SHADOW_ENABLED='true';
 const request=input(),m=manifest({...request,cutoff:new Date().toISOString()} as AuditJob);
 await putAuditBlob(bytes);
 for(const id of ['readable','image-only']){
  const hash=await putAuditBlob(Buffer.from('%PDF-1.7 synthetic '+id));
  m.sources.push({id,name:id+'.pdf',kind:'support',sha256:hash,capturedAt:m.cutoff,pages:Array.from({length:80},(_,i)=>({number:i+1,text:id==='image-only'&&i===0?'':'Synthetic readable page text.',rendered:true,inkRatio:.1,...(id==='image-only'&&i===0?{textNeedsReview:true}:{})}))});
 }
 const saved=globalThis.fetch;const requests:{input:{content:{type:string;text?:string;filename?:string}[]}[]}[]=[];
 globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(String(init!.body)));return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({findings:[],resolutions:[],coverage:requests.length<3?['A source is outside this bounded pass.']:['Global coverage summary.']})}]}]}));};
 let reviewed;try{reviewed=await new OpenAIAuditReviewer().review(m);}finally{globalThis.fetch=saved;}
 assert.equal(reviewed.coverageScope,"consolidated");assert.equal(reviewed.sourcePassCoverage?.length,2);assert.ok(!reviewed.coverage.some(line=>line.includes("outside this bounded pass")));assert.ok(reviewed.sourcePassCoverage![0].coverage.some(line=>line.includes("outside this bounded pass")));
 assert.equal(requests.length,3);
 const content=requests.at(-1)!.input[0].content,payload=JSON.parse(content[0].text!);
 assert.deepEqual(payload.visualSourceIds,['image-only']);
 assert.equal(content.filter(c=>c.type==='input_file').length,1);
});

test("initial report view loads saved findings without Drive or source manifests",async()=>{
 const {job,report}=await complete();
 const {auditViewSnapshot}=await import('../../src/lib/orchestrator/audit-view.ts');
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>{throw new Error('Report display must not access a network service');};
 try{
  const view=await auditViewSnapshot(job.matterId);
  assert.deepEqual(view.report,report);
  assert.equal(view.jobs.length,1);
  assert.equal('manifest' in view.jobs[0],false);
  assert.equal(view.jobs[0].sourceSummary?.packagePages,1);
  assert.equal('sources' in view,false);
 }finally{globalThis.fetch=originalFetch;}
});
