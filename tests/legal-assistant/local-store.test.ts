import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyLocalBatch, localSnapshot, saveVerifiedLocalFolder, localStateDirectory } from "../../src/lib/orchestrator/local-store.ts";
import { parseCloserReport } from "../../src/lib/orchestrator/closer-import.ts";

test("private development store commits atomically, deduplicates and retains folder mappings",async()=>{
 const previous=process.env.ORCHESTRATOR_LOCAL_STATE_DIR;
 const directory=await mkdtemp(path.join(tmpdir(),"orchestrator-store-"));
 process.env.ORCHESTRATOR_LOCAL_STATE_DIR=directory;
 try {
  const batch=parseCloserReport("Closer_Report_Closing_2026-10-01_to_2026-12-31_run_2026-10-20.csv","file.number,file.type,file.status,file.url,dates.closing,property.address,file.clerk,file.lawyer,clients.names\n26P-0901,purchase,active,https://app.closer.ca/app/matter/one,2026-10-21,18 Maple Grove,Marcela,Kubes,Alex");
  const a=await applyLocalBatch(batch,"first",0,"test-user");assert.equal(a.revision,1);
  const duplicate=await applyLocalBatch(batch,"first",0,"test-user");assert.equal(duplicate.duplicate,true);assert.equal(duplicate.revision,1);
  await saveVerifiedLocalFolder({id:batch.matters[0].id,folderId:"verified",name:"26P-0901 - 18 Maple Grove",rootId:"approved",actor:"test-user",expectedRevision:1});
  await assert.rejects(applyLocalBatch(batch,"second",1,"test-user"),/Data changed/);
  const b=await applyLocalBatch(batch,"second",2,"test-user");assert.equal(b.matters[0].driveFolderId,"verified");
  const attempts=await Promise.allSettled([applyLocalBatch(batch,"third",3,"test-user"),applyLocalBatch(batch,"fourth",3,"test-user")]);
  assert.equal(attempts.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await localSnapshot()).matters.length,1);
 } finally {if(previous===undefined)delete process.env.ORCHESTRATOR_LOCAL_STATE_DIR;else process.env.ORCHESTRATOR_LOCAL_STATE_DIR=previous;await rm(directory,{recursive:true,force:true});}
});
test("local client records can never be stored under public",()=>{
 const previous=process.env.ORCHESTRATOR_LOCAL_STATE_DIR;process.env.ORCHESTRATOR_LOCAL_STATE_DIR="public/client-data";
 try{assert.throws(()=>localStateDirectory(),/Unsafe/);}finally{if(previous===undefined)delete process.env.ORCHESTRATOR_LOCAL_STATE_DIR;else process.env.ORCHESTRATOR_LOCAL_STATE_DIR=previous;}
});
