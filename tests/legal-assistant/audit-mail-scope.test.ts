import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditMailQuery,hasAuditAddress,verifiedAddressThread} from '../../src/lib/orchestrator/audit-mail-scope.ts';
import type {AuditJob} from '../../src/lib/orchestrator/audit-model.ts';
const job={matterNumber:'26S-0001',cutoff:'2026-10-28T10:00:00Z',mailScope:{address:'12 Example Drive, Toronto, ON',clients:'Example Seller, Second Seller',clientEmails:['seller@example.test']}} as AuditJob;
const thread=(subject:string,text:string,contacts='seller@example.test')=>[{subject,text,contacts}];
test('address variants discover relevant mail but not adjacent street numbers',()=>{
 assert.equal(hasAuditAddress('Re: 12 Example Dr closing','12 Example Drive, Toronto'),true);
 assert.equal(hasAuditAddress('112 Example Dr','12 Example Drive, Toronto'),false);
 assert.equal(hasAuditAddress('12 Example Dr','212 Example Drive, Toronto'),false);
 assert.equal(hasAuditAddress('13-12 Example Dr','14-12 Example Dr, Toronto'),false);
 assert.match(auditMailQuery(job),/"12 Example"/);assert.match(auditMailQuery(job),/26S0001/);
});
test('address evidence requires client corroboration and rejects competing files',()=>{
 assert.equal(verifiedAddressThread(thread('12 Example Dr','Extension'),job),true);
 assert.equal(verifiedAddressThread(thread('12 Example Dr','Extension','stranger@example.test'),job),false);
 assert.equal(verifiedAddressThread(thread('12 Example Dr','Example Seller confirms',''),job),true);
 assert.equal(verifiedAddressThread(thread('12 Example Dr','26S-0002 unrelated'),job),false);
 assert.equal(verifiedAddressThread(thread('112 Example Dr','Extension'),job),false);
});
