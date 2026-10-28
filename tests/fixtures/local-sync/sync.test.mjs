import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {synchronize} from './sync.mjs';
import {parseCloserReport} from './closer-import.ts';
import {selectReport} from './report-selection.ts';
const filename='Closer_Report_Closing_2026-10-27_to_2026-11-30_run_2026-10-27.csv';
const csv='file.number,file.type,file.status,file.url,dates.closing,property.address,file.clerk,file.lawyer,clients.names\n26P-0901,purchase,active,https://app.closer.ca/app/matter/example,2026-10-30,42 Example Road,Example Clerk,Example Lawyer,Example Buyer';
async function fixture(fn){const dir=await mkdtemp(path.join(os.tmpdir(),'daily-sync-test-'));const old=process.env.ORCHESTRATOR_LOCAL_STATE_DIR;process.env.ORCHESTRATOR_LOCAL_STATE_DIR=dir;try{const b=parseCloserReport(filename,csv);const prior={...b.matters[0],sourceDate:'2026-10-26',driveFolderId:'verified-folder',firm:'iclosed'};await writeFile(path.join(dir,'state.json'),JSON.stringify({revision:4,sourceDate:'2026-10-26',coverageStart:'2026-10-01',coverageEnd:'2026-11-30',matters:[prior],imports:[{checksum:'prior',filename:'prior',actor:'test',at:'2026-10-26'}],changes:[],folderChecks:[]}));await fn(dir,prior);}finally{if(old===undefined)delete process.env.ORCHESTRATOR_LOCAL_STATE_DIR;else process.env.ORCHESTRATOR_LOCAL_STATE_DIR=old;await rm(dir,{recursive:true,force:true});}}
test('unchanged business rows retain fields and row source date; new receipt reads back; duplicate is a no-op',async()=>fixture(async(dir,prior)=>{const extract=async()=>({batch:parseCloserReport(filename,csv),csv,sourceId:'synthetic'});const a=await synchronize({today:'2026-10-27',extract});assert.equal(a.verified,true);assert.equal(a.updated,0);assert.equal(a.unchanged,1);assert.equal(a.receiptVerified,true);const saved=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8'));assert.deepEqual(saved.matters,[prior]);assert.equal(saved.revision,5);assert.equal(saved.imports.length,2);const before=await readFile(path.join(dir,'state.json'),'utf8');const b=await synchronize({today:'2026-10-27',extract});assert.equal(b.duplicate,true);assert.equal(await readFile(path.join(dir,'state.json'),'utf8'),before);}));
test('business deltas persist and preserve verified local fields',async()=>fixture(async(dir)=>{const changed=csv.replace('2026-10-30','2026-11-02');const result=await synchronize({today:'2026-10-27',extract:async()=>({batch:parseCloserReport(filename,changed),csv:changed,sourceId:'synthetic'})});assert.equal(result.verified,true);assert.equal(result.updated,1);const row=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).matters[0];assert.equal(row.closingDate,'2026-11-02');assert.equal(row.driveFolderId,'verified-folder');assert.equal(row.firm,'iclosed');}));
test('missing source leaves baseline byte-for-byte unchanged',async()=>fixture(async(dir)=>{const before=await readFile(path.join(dir,'state.json'),'utf8');const result=await synchronize({extract:async()=>{throw Error("Today's full-coverage detailed extract is not available. Existing data retained.");}});assert.equal(result.verified,false);assert.match(result.error,/Fresh full-coverage/);assert.equal(await readFile(path.join(dir,'state.json'),'utf8'),before);}));
test('freshness, full coverage and unique source selection remain mandatory',()=>{const source={id:'test',name:filename};assert.equal(selectReport([source],'2026-10-27','2026-10-27','2026-11-27',true),source);assert.throws(()=>selectReport([source],'2026-10-28','2026-10-28','2026-11-28',true));assert.throws(()=>selectReport([source],'2026-10-27','2026-10-27','2026-12-01',true));assert.throws(()=>selectReport([source,{...source,id:'duplicate'}],'2026-10-27','2026-10-27','2026-11-27',true));});

// Contact metadata must survive recurring imports and retain verified local fields.
test('all client/referring-agent emails synchronize as deltas without copying opposing agents',async()=>fixture(async(dir)=>{
 const [head,row]=csv.split('\n');
 const detailed=head+',clients.list.0.email,clients.list.1.email,brokerage.agent.email,otherPartyBrokerage.agent.email\n'+row+',one@example.test,two@example.test,agent@example.test,opposing@example.test';
 const result=await synchronize({today:'2026-10-27',extract:async()=>({batch:parseCloserReport(filename,detailed),csv:detailed,sourceId:'synthetic'})});
 assert.equal(result.verified,true);assert.equal(result.updated,1);
 const saved=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).matters[0];
 assert.deepEqual(saved.clientEmails,['one@example.test','two@example.test']);assert.deepEqual(saved.referralAgentEmails,['agent@example.test']);assert.equal(saved.driveFolderId,'verified-folder');
 const next=detailed.replace('two@example.test','updated@example.test');
 const changed=await synchronize({today:'2026-10-27',extract:async()=>({batch:parseCloserReport(filename,next),csv:next,sourceId:'synthetic'})});assert.equal(changed.verified,true);assert.equal(changed.updated,1);
 assert.deepEqual(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).matters[0].clientEmails,['one@example.test','updated@example.test']);
}));
