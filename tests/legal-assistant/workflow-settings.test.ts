import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {reviewReportComment,recordMortgageClientsInformed,workflowSettings,saveMunicipality,recordMortgageReceipt,addReportComment,resolveMunicipality,seedMunicipalities,validateMunicipality} from '../../src/lib/orchestrator/workflow-settings.ts';
test('shared directory revisions, mortgage timestamps and overall comments persist independently of Closer imports',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'workflow-settings-')),old=process.env.ORCHESTRATOR_LOCAL_STATE_DIR;process.env.ORCHESTRATOR_LOCAL_STATE_DIR=root;try{
 const initial=await workflowSettings();const ajax=structuredClone(initial.municipalities.find(m=>m.id==='ajax')!);ajax.tax.email='updated@example.com';const saved=await saveMunicipality(ajax,initial.revision,'staff@example.com');assert.equal(saved.revision,1);assert.equal(resolveMunicipality('10 Example St, Ajax, ON',saved.entries).tax.email,'updated@example.com');assert.equal((await workflowSettings()).municipalities.find(m=>m.id==='ajax')?.updatedBy,'staff@example.com');await assert.rejects(saveMunicipality(ajax,0,'other@example.com'),/directory changed/);
 const first=await recordMortgageReceipt('test-matter','user1','clerk@example.com'),second=await recordMortgageReceipt('test-matter','user2','other@example.com');assert.deepEqual(second,first);assert.ok(Number.isFinite(Date.parse(first.at)));assert.equal(first.actor,'user1');assert.deepEqual((await workflowSettings()).mortgage['test-matter'],first);
 assert.equal((await workflowSettings()).mortgageClientsInformed?.['test-matter'],undefined);
 await assert.rejects(recordMortgageClientsInformed('test-matter','user1','clerk@example.com',false),/Confirm/);
 const informed=await recordMortgageClientsInformed('test-matter','user1','clerk@example.com',true);
 assert.deepEqual(await recordMortgageClientsInformed('test-matter','user2','other@example.com',true),informed);
 assert.deepEqual((await workflowSettings()).mortgageClientsInformed?.['test-matter'],informed);
 assert.deepEqual((await workflowSettings()).mortgage['test-matter'],first);
 const comment=await addReportComment('test-matter',2,'Focus more on lender conditions; avoid unsigned-template false alarms.','user1','clerk@example.com');assert.equal(comment.reportRevision,2);assert.equal((await workflowSettings()).comments.length,1);assert.equal((await workflowSettings()).revision,1);
 }finally{if(old===undefined)delete process.env.ORCHESTRATOR_LOCAL_STATE_DIR;else process.env.ORCHESTRATOR_LOCAL_STATE_DIR=old;await rm(root,{recursive:true,force:true});}});
test('municipal contacts cannot merge different departments or inject email headers',()=>{const ajax=structuredClone(seedMunicipalities().find(m=>m.id==='ajax')!);ajax.combine=true;assert.throws(()=>validateMunicipality(ajax),/same organization/);ajax.combine=false;ajax.tax.email='tax@example.com\nBcc: unwanted@example.com';assert.throws(()=>validateMunicipality(ajax),/valid municipal/);});
test('unknown or ambiguous localities do not inherit a guessed department',()=>{const entries=seedMunicipalities();assert.equal(resolveMunicipality('10 Toronto Street, Unknown, ON',entries).id,'');assert.equal(resolveMunicipality('10 Example, Ajax, ON',[...entries,{...entries[0],id:'ambiguous',aliases:['Ajax']}]).id,'');});

test('new contact defaults fill older directories while preserving explicit custom locality routes',()=>{const miss=seedMunicipalities().find(m=>m.id==='mississauga')!;assert.equal(resolveMunicipality('42 Example Road, Mississauga, ON',[]).tax.email,'tax@mississauga.ca');const custom={...miss,id:'custom-mississauga',tax:{...miss.tax,email:'custom@example.test'}};assert.equal(resolveMunicipality('42 Example Road, Mississauga, ON',[custom]).tax.email,'custom@example.test');});

test('feedback approvals preserve attribution, reject stale reviews and require approval before implementation',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'feedback-review-')),old=process.env.ORCHESTRATOR_LOCAL_STATE_DIR;process.env.ORCHESTRATOR_LOCAL_STATE_DIR=root;
 try{
 const feedback=await addReportComment('',null,'General improvement proposal.','author','author@example.com');
 assert.equal(feedback.status,'pending');
 await assert.rejects(reviewReportComment(feedback.id,'implemented','pending','','reviewer','reviewer@example.com'),/Approve/);
 await reviewReportComment(feedback.id,'approved','pending','Ready for implementation.','reviewer','reviewer@example.com');
 await assert.rejects(reviewReportComment(feedback.id,'declined','pending','','other','other@example.com'),/changed/);
 const saved=await reviewReportComment(feedback.id,'implemented','approved','Implemented and verified.','reviewer','reviewer@example.com');
 assert.equal(saved.email,'author@example.com');assert.equal(saved.fileId,'');assert.equal(saved.comment,feedback.comment);assert.equal(saved.status,'implemented');assert.equal(saved.reviews?.length,2);assert.equal(saved.reviews?.[0].email,'reviewer@example.com');assert.equal((await workflowSettings()).comments[0].reviews?.[1].note,'Implemented and verified.');
 }finally{if(old===undefined)delete process.env.ORCHESTRATOR_LOCAL_STATE_DIR;else process.env.ORCHESTRATOR_LOCAL_STATE_DIR=old;await rm(root,{recursive:true,force:true});}
});
