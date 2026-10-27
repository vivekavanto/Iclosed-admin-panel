import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditCoverageSummary} from '../../src/lib/orchestrator/audit-coverage.ts';
import {validateCandidate,type AuditManifest} from '../../src/lib/orchestrator/audit-model.ts';
const manifest:AuditManifest={matterId:'test',matterNumber:'26P-0001',packageHash:'a'.repeat(64),cutoff:'2026-10-01',ruleset:'test',limitations:[],sources:[{id:'p',name:'Package.pdf',kind:'package',sha256:'a'.repeat(64),capturedAt:'2026-10-01',pages:[{number:1,text:'Payout $100.00, ledger $101.00, per diem $1.00',rendered:true,inkRatio:.1,textMethod:'ocr',ocrConfidence:.9}]}]};
test('coverage exposes document names and OCR/readability without exposing document text',()=>{
 const result=auditCoverageSummary(manifest)!;assert.equal(result.ocrPages,1);assert.equal(result.packagePages,1);assert.equal(result.sources[0].name,'Package.pdf');assert.equal(JSON.stringify(result).includes('Payout'),false);assert.equal(auditCoverageSummary(undefined),undefined);
});
test('OCR quotations remain reviewable but cannot independently propose a signing blocker',()=>{
 const result=validateCandidate({key:'date-conflict',kind:'discrepancy',summary:'Two amounts differ',action:'Check source image',proposedBlocker:true,claim:'text',evidence:[{sourceId:'p',page:1,quote:'Payout $100.00'}]},manifest);
 assert.equal(result.kind,'discrepancy');assert.equal(result.proposedBlocker,false);assert.match(result.validation[0],/OCR/);
});
test('explained arithmetic never upgrades an unverified quotation into a verified question',()=>{
 const result=validateCandidate({key:'payout',kind:'discrepancy',summary:'Difference',action:'Check',proposedBlocker:true,claim:'text',financial:{type:'per_diem',baseCents:10000,comparedCents:10100,adjustmentCents:100},evidence:[{sourceId:'p',page:1,quote:'Invented: $100.00 $101.00 $1.00'}]},manifest);
 assert.equal(result.kind,'unable_to_assess');assert.equal(result.proposedBlocker,false);
});
test('a split digit in an explicitly dollar-denominated PDF amount can still reconcile',()=>{
 const m=structuredClone(manifest);m.sources[0].pages[0].text='Ledger $ 8 37,686.63; payout $837,591.36; per diem $95.27.';
 const result=validateCandidate({key:'payout',kind:'discrepancy',summary:'Difference',action:'Confirm receipt timing',proposedBlocker:true,claim:'text',financial:{type:'per_diem',baseCents:83759136,comparedCents:83768663,adjustmentCents:9527},evidence:[{sourceId:'p',page:1,quote:m.sources[0].pages[0].text}]},m);
 assert.equal(result.kind,'question');assert.equal(result.proposedBlocker,false);
});

test('rendering failures are distinguished from limited OCR text and email messages',()=>{
 const m=structuredClone(manifest);m.sources[0].pages[0].text='';m.sources[0].pages[0].textNeedsReview=true;
 assert.equal(auditCoverageSummary(m)!.unreadablePages,1);assert.equal(auditCoverageSummary(m)!.unrenderedPages,0);
 m.sources[0].pages[0].rendered=false;assert.equal(auditCoverageSummary(m)!.unrenderedPages,1);
 m.sources[0].kind='email';assert.equal(auditCoverageSummary(m)!.unrenderedPages,0);
});
