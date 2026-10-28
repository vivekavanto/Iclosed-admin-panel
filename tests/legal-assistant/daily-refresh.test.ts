import test from 'node:test';import assert from 'node:assert/strict';
import {dailyCloserRefresh} from '../../src/lib/orchestrator/daily-refresh.ts';
import type {ImportBatch} from '../../src/lib/orchestrator/model.ts';
const now=new Date('2026-10-23T06:15:00Z');
const batch:ImportBatch={filename:'synthetic.csv',kind:'detailed',sourceDate:'2026-10-23',coverageStart:'2026-10-01',coverageEnd:'2026-12-31',matters:[],warnings:[]};
function fixture(){let writes=0,reads=0,extracts=0;const state={revision:1,sourceDate:null as string|null,coverageStart:null as string|null,coverageEnd:null as string|null};const deps={snapshot:async()=>{reads++;return {...state};},extract:async()=>{extracts++;return {batch:{...batch},csv:'synthetic',sourceId:'report'};},checksum:()=> 'checksum',apply:async(_b:ImportBatch,_c:string,revision:number,actor:string)=>{assert.equal(revision,state.revision);assert.equal(actor,'daily-drive:report');writes++;state.revision++;state.sourceDate=_b.sourceDate;state.coverageStart=_b.coverageStart;state.coverageEnd=_b.coverageEnd;return {...state};}};return {deps,counts:()=>({writes,reads,extracts})};}
const config={secret:'synthetic-secret',enabled:true,scheduled:true};
test('machine refresh rejects missing or wrong secrets before accessing data',async()=>{
 const f=fixture();for(const authorization of [null,'Bearer wrong'])assert.equal((await dailyCloserRefresh(authorization,config,f.deps,now)).status,401);
 assert.deepEqual(f.counts(),{writes:0,reads:0,extracts:0});
 assert.equal((await dailyCloserRefresh('Bearer ',{...config,secret:undefined},f.deps,now)).status,401);
});
test('deployment flag prevents all reads and writes until activation',async()=>{
 const f=fixture();const result=await dailyCloserRefresh('Bearer synthetic-secret',{...config,enabled:false},f.deps,now);
 assert.equal(result.status,200);assert.equal(result.body.imported,false);assert.equal(f.counts().reads,0);
});
test('DST companion run skips an extract already incorporated today',async()=>{
 const f=fixture();assert.equal((await dailyCloserRefresh('Bearer synthetic-secret',config,f.deps,now)).body.imported,true);
 assert.equal((await dailyCloserRefresh('Bearer synthetic-secret',config,f.deps,new Date('2026-10-23T07:15:00Z'))).body.imported,false);
 assert.deepEqual(f.counts(),{writes:1,reads:2,extracts:1});
});
test('winter early run waits; spring missing 02:15 gets a later run',async()=>{
 const f=fixture();await dailyCloserRefresh('Bearer synthetic-secret',config,f.deps,new Date('2026-12-02T06:15:00Z'));assert.equal(f.counts().reads,0);
 const g=fixture();const result=await dailyCloserRefresh('Bearer synthetic-secret',config,g.deps,new Date('2027-03-14T06:15:00Z'));assert.equal(result.body.imported,false);assert.equal(g.counts().reads,0);
 g.deps.extract=async()=>({batch:{...batch,sourceDate:'2027-03-14',coverageStart:'2027-03-01',coverageEnd:'2027-04-30'},csv:'synthetic',sourceId:'report'});
 assert.equal((await dailyCloserRefresh('Bearer synthetic-secret',config,g.deps,new Date('2027-03-14T07:15:00Z'))).body.imported,true);assert.equal(g.counts().writes,1);
});
test('stale, partial or unavailable extracts never write or expose provider data',async()=>{
 for(const changed of [{sourceDate:'2026-10-22'},{coverageEnd:'2026-11-01'},{coverageStart:'2026-10-24'},{kind:'summary' as const}]){
 const f=fixture();f.deps.extract=async()=>({batch:{...batch,...changed},csv:'synthetic',sourceId:'report'});
 assert.equal((await dailyCloserRefresh('Bearer synthetic-secret',config,f.deps,now)).status,409);assert.equal(f.counts().writes,0);
 }
 const f=fixture();f.deps.extract=async()=>{throw new Error('private provider/client details');};const r=await dailyCloserRefresh('Bearer synthetic-secret',config,f.deps,now);assert.equal(r.status,409);assert.doesNotMatch(JSON.stringify(r),/private provider/);assert.equal(f.counts().writes,0);
});
test('a partial manual import today does not suppress the scheduled full import',async()=>{
 const f=fixture();f.deps.snapshot=async()=>({revision:1,sourceDate:'2026-10-23',coverageStart:'2026-10-23',coverageEnd:'2026-10-24'});
 const r=await dailyCloserRefresh('Bearer synthetic-secret',config,f.deps,now);assert.equal(r.body.imported,true);assert.equal(f.counts().writes,1);
});
