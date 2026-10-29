import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { JOURNEY_TRACKING, trackingTitle, ownershipResponsible } from '../src/lib/purchaseJourney.ts';

const partnerId='11111111-1111-4111-a111-111111111111';
const leadId='22222222-2222-4222-a222-222222222222';
const source=readFileSync(new URL('../src/app/api/admin/agent-portal/[partnerId]/files/[leadId]/journey/route.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(options: {status?: string; root?: boolean; authenticated?: boolean; conflict?: boolean; city?: string} = {}) {
  let stored: Record<string,unknown>|null=null;
  const writes: Record<string,unknown>[]=[];
  const audit: unknown[]=[];
  const supabase={from(table: string){
    let operation='read'; let payload: Record<string,unknown>|null=null;
    const query: Record<string,unknown>={};
    for(const method of ['select','eq','is','maybeSingle','single']) query[method]=()=>query;
    query.insert=(row: Record<string,unknown>)=>{operation='insert';payload=row;return query;};
    query.update=(row: Record<string,unknown>)=>{operation='update';payload=row;return query;};
    query.then=(resolve: (value: unknown)=>unknown)=>{
      if(table==='deals') return Promise.resolve(resolve({data:[{id:'deal',type:'Purchase',status:options.status??'Active'}],error:null}));
      if(table==='leads') return Promise.resolve(resolve({data:{address_city:options.city??'Mississauga'},error:null}));
      if(operation==='read') return Promise.resolve(resolve({data:stored,error:null}));
      if(options.conflict) return Promise.resolve(resolve({data:null,error:{code:'23505'}}));
      writes.push(payload!);stored=payload;
      return Promise.resolve(resolve({data:[{id:payload!.id}],error:null}));
    };
    return query;
  }};
  const modules: Record<string,unknown>={
    'next/server':{NextResponse:{json:(body: unknown,{status=200}: {status?:number}={})=>({status,body})}},
    'node:crypto':awaitableCrypto,
    '@/lib/supabaseAdmin':{default:supabase},
    '@/lib/isUuid':{isUuid:(s:string)=>/^[a-f0-9-]{36}$/.test(s)},
    '@/lib/agentPortalData':{loadAgentRootLead:async()=>options.root===false?null:leadId},
    '@/lib/purchaseJourney':{JOURNEY_TRACKING,trackingTitle,ownershipResponsible},
    '@/lib/getActingAdmin':{getActingAdmin:async()=>({id:options.authenticated===false?null:'staff',email:'staff@example.test'})},
    '@/lib/recordAudit':{recordAudit:async(value:unknown)=>{audit.push(value);}},
    '@/lib/logger':{logger:{error(){}}},
  };
  const exports: {PUT?: (req:unknown,params:unknown)=>Promise<{status:number;body:unknown}>}={};
  vm.runInNewContext(code,{exports,require:(id:string)=>{assert.ok(id in modules,id);return modules[id];}});
  return {writes,audit,call:async(body: unknown)=>exports.PUT!({json:async()=>body},{params:Promise.resolve({partnerId,leadId})})};
}
import * as awaitableCrypto from 'node:crypto';

test('staff progress writes are scoped, audited and never complete a client milestone',async()=>{
  const f=fixture();
  assert.equal((await f.call({key:'ownership',completed:true,expectedCompletedAt:null,responsible:'iClosed'})).status,200);
  assert.equal(f.writes.length,1);
  const row=f.writes[0];
  assert.equal(row.title,'[Agent journey] Change of ownership submitted (Client)');
  assert.equal(row.role_type,'Admin');assert.equal(row.milestone_id,null);assert.equal(row.task_template_id,null);
  assert.equal(row.activation_required,true);assert.equal(row.activated_at,null);
  assert.equal(row.completed,true);assert.equal(f.audit.length,1);
  assert.equal((await f.call({key:'ownership',completed:true,expectedCompletedAt:null})).status,409,'stale retry cannot overwrite');
  assert.equal(f.writes.length,1);
});
test('invalid requests, unauthenticated staff, unrelated files and locked records cannot write',async()=>{
  for(const [options,body,status] of [
    [{},{key:'anything',completed:true,expectedCompletedAt:null},400],
    [{},{key:'writ',completed:'yes',expectedCompletedAt:null},400],
    [{},{key:'writ',completed:true},400],
    [{authenticated:false},{key:'writ',completed:true,expectedCompletedAt:null},401],
    [{root:false},{key:'writ',completed:true,expectedCompletedAt:null},404],
    [{status:'Cancelled'},{key:'ownership',completed:true,expectedCompletedAt:null},409],
    [{status:'Inactive'},{key:'keys',completed:true,expectedCompletedAt:null},409],
    [{status:'Closed'},{key:'writ',completed:true,expectedCompletedAt:null},409],
    [{conflict:true},{key:'keys',completed:true,expectedCompletedAt:null},409],
  ] as const){const f=fixture(options);assert.equal((await f.call(body)).status,status);assert.equal(f.writes.length,0);}
});
test('closed files allow post-closing confirmation and other jurisdictions can assign the client',async()=>{
  for(const key of ['ownership','keys']){const f=fixture({status:'Closed',city:'Toronto'});assert.equal((await f.call({key,completed:true,expectedCompletedAt:null,...(key==='ownership'?{responsible:'Client'}:{})})).status,200);}
  const f=fixture({city:'Toronto'});await f.call({key:'ownership',completed:false,expectedCompletedAt:null,responsible:'Client'});
  assert.equal(f.writes[0].title,'[Agent journey] Change of ownership submitted (Client)');
});
