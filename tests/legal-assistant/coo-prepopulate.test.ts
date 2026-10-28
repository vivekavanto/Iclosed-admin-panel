import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {prepopulateCoo} from '../../src/lib/coo/prepopulate.ts';
import type {TransferFacts} from '../../src/lib/coo/transfer-heading.ts';
import type {CooDraft} from '../../src/lib/coo/model.ts';
const draft=JSON.parse(fs.readFileSync(new URL('./fixtures/coo-demo.json',import.meta.url),'utf8')) as CooDraft;
const base={...draft,fileNumber:'26P-0001',property:'2-42 Example Road, Toronto',transaction:'purchase' as const,effectiveDate:'2026-10-23'};
const facts:TransferFacts={instrument:'AT1234567',registrationDate:'2026-10-23',pages:4,complete:true,properties:[{address:'2 UNIT 42 EXAMPLE ROAD TORONTO',description:'LOT 1 PLAN 2'}],transferors:[{name:'Seller Example',address:'10 Old Road'}],transferees:[{name:'Buyer Example',address:'2-42 Example Road, Toronto'}],solicitors:[{role:'transferor',contact:'Wrong Lawyer',email:'wrong@example.test',phone:'111'},{role:'transferee',contact:'Right Lawyer',email:'right@example.test',phone:'222'}],fileNumbers:{transferee:'26P-0001',transferor:'26S-0002'}};
test('routine purchase reads registered owners and service address while preserving trusted contacts',()=>{const p=prepopulateCoo(base,facts);assert.equal(p.draft.newOwners,'Buyer Example');assert.equal(p.draft.forwardingAddress,'2-42 Example Road, Toronto');assert.equal(p.draft.registrationDate,'2026-10-23');assert.deepEqual(p.draft.recipients,base.recipients);assert.equal(p.draft.completeTransferConfirmed,false);assert.deepEqual(p.exceptions,[]);});
test('sale uses the transferee solicitor rather than submitting or transferor lawyer',()=>{const p=prepopulateCoo({...base,fileNumber:'26S-0002',transaction:'sale'},facts);assert.equal(p.draft.clients,'Seller Example');assert.match(p.draft.purchaserSolicitor!,/Right Lawyer/);assert.doesNotMatch(p.draft.purchaserSolicitor!,/Wrong/);assert.equal(p.draft.forwardingAddress,'');});
test('different service addresses and dates remain visible exceptions without losing extracted facts',()=>{const p=prepopulateCoo({...base,effectiveDate:'2026-10-22'},{...facts,transferees:[...facts.transferees,{name:'Other Owner',address:'9 Other Road'}]});assert.equal(p.exceptions.length,2);assert.match(p.draft.forwardingAddress,/Buyer Example:.*\nOther Owner:/);assert.equal(p.draft.differentDatesConfirmed,false);});
test('rejects incomplete, wrong matter, wrong role and mismatched unit deeds',()=>{assert.throws(()=>prepopulateCoo(base,{...facts,complete:false}),/complete/);assert.throws(()=>prepopulateCoo({...base,fileNumber:'26P-9999'},facts),/client file/);assert.throws(()=>prepopulateCoo({...base,transaction:'sale'},facts),/client file/);assert.throws(()=>prepopulateCoo({...base,property:'3-42 Example Road, Toronto'},facts),/address/);});

test('registered shares are preserved and an incomplete total is an exception',()=>{const p=prepopulateCoo(base,{...facts,transferees:[{name:'Buyer Example',address:'2-42 Example Road, Toronto',share:99}]});assert.match(p.exceptions[0],/do not total 100/);assert.equal(p.draft.newOwners,'Buyer Example');});
test('wrong street with matching civic numbers is rejected',()=>{assert.throws(()=>prepopulateCoo({...base,property:'2-42 Different Road, Toronto'},facts),/street name/);});

test('a deed condo plan establishes condo identity even when Closer omitted its property type',()=>{
 const p=prepopulateCoo({...base,condominium:false,condoCorporation:''},{...facts,properties:[{...facts.properties[0],description:'UNIT 1 TORONTO STANDARD CONDOMINIUM PLAN NO. 3196'}]});
 assert.equal(p.draft.condominium,true);assert.match(p.draft.condoCorporation!,/CORPORATION NO. 3196/);
});
