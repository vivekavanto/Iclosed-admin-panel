import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { assertClerkFieldsPreserved, inspectAuditDoc, type NativeAuditDoc, AuditGoogleDocs } from "../../src/lib/orchestrator/google-audit-docs.ts";
import { AuditMailbox } from "../../src/lib/orchestrator/google-audit-mail.ts";
const cell=(text:string,start:number)=>({content:[{startIndex:start,endIndex:start+text.length+1,paragraph:{elements:[{textRun:{content:text+"\n"}}]}}]});
const tracker:NativeAuditDoc={documentId:"test",revisionId:"r1",tabs:[{documentTab:{body:{content:[{table:{columns:7,rows:2,tableRows:[{tableCells:[cell("Finding ID",1),cell("Priority",15),cell("Discrepancy",30),cell("Required action",50),cell("Clerk disposition",70),cell("Clerk notes",100),cell("Re-audit result",120)]},{tableCells:[cell("F-001",150),cell("High",170),cell("Mismatch",180),cell("Verify",200),cell("Incorrectly flagged",220),cell("Preserve my note",250),cell("Pending",280)]}]}}]}}}]};
test("native report inspection includes child tabs and actual tables",()=>{
 const report={...tracker,tabs:[...tracker.tabs!,{childTabs:[{documentTab:{body:{content:[{paragraph:{paragraphStyle:{namedStyleType:"HEADING_1"},elements:[{textRun:{content:"History\n"}}]}}]}}}]}]};
 const shape=inspectAuditDoc(report);assert.equal(shape.tables[0].columns,7);assert.ok(shape.headings.includes("History"));assert.match(shape.text,/Preserve my note/);
});
test("rerun cannot overwrite clerk notes or dispositions",()=>{
 for(const index of [225,255])assert.throws(()=>assertClerkFieldsPreserved(tracker,[{insertText:{location:{index},text:"replacement"}}]),/human-controlled/);
 assert.throws(()=>assertClerkFieldsPreserved(tracker,[{deleteContentRange:{range:{startIndex:200,endIndex:280}}}]),/human-controlled/);
 assert.doesNotThrow(()=>assertClerkFieldsPreserved(tracker,[{insertText:{location:{index:285},text:"Verified"}}]));
});
test("reject replacements or shifting batches that could erase human fields",()=>{
 assert.throws(()=>assertClerkFieldsPreserved(tracker,[{replaceAllText:{containsText:{text:"Incorrectly flagged"},replaceText:"Open"}}]),/bounded text edits/);
 assert.throws(()=>assertClerkFieldsPreserved(tracker,[{insertText:{location:{index:10},text:"New text"}},{insertText:{location:{index:200},text:"Shifted"}}]),/end toward/);
});
test("report writes remain off without explicit configuration",async()=>{
 const previous=process.env.ORCHESTRATOR_AUDIT_WRITES_ENABLED;delete process.env.ORCHESTRATOR_AUDIT_WRITES_ENABLED;
 try{await assert.rejects(AuditGoogleDocs.update({documentId:"doc",matterFolderId:"matter",auditFolderId:"audit",expectedRevision:"r1",requests:[{insertText:{location:{index:1},text:"x"}}]}),/not enabled/);}finally{if(previous===undefined)delete process.env.ORCHESTRATOR_AUDIT_WRITES_ENABLED;else process.env.ORCHESTRATOR_AUDIT_WRITES_ENABLED=previous;}
});
test("website mailbox refuses a credential for another user before reading messages",async()=>{
 const originalFetch=globalThis.fetch;const original=process.env.ORCHESTRATOR_GMAIL_SERVICE_ACCOUNT_JSON;
 const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});process.env.ORCHESTRATOR_GMAIL_SERVICE_ACCOUNT_JSON=JSON.stringify({client_email:"test@example.iam.gserviceaccount.com",private_key:privateKey.export({type:"pkcs8",format:"pem"})});
 const calls:string[]=[];globalThis.fetch=async(input)=>{const url=String(input);calls.push(url);return new Response(JSON.stringify(url.includes("oauth2")?{access_token:"test-token"}:{emailAddress:"wrong@navawilson.law"}),{status:200});};
 try{await assert.rejects(AuditMailbox.connect(),/identity mismatch/);assert.equal(calls.length,2);assert.ok(!calls.some(x=>x.includes("/messages")));}finally{globalThis.fetch=originalFetch;if(original===undefined)delete process.env.ORCHESTRATOR_GMAIL_SERVICE_ACCOUNT_JSON;else process.env.ORCHESTRATOR_GMAIL_SERVICE_ACCOUNT_JSON=original;}
});

test("existing report updates use the real Drive API and enforce destination and revision guards", async () => {
 const originalFetch=globalThis.fetch;
 const keys=["ORCHESTRATOR_AUDIT_WRITES_ENABLED","ORCHESTRATOR_GOOGLE_WRITER_SERVICE_ACCOUNT_JSON","ORCHESTRATOR_GOOGLE_SERVICE_ACCOUNT_JSON","ORCHESTRATOR_AUDIT_OUTPUT_FOLDER_IDS"] as const;
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
 const account=JSON.stringify({client_email:"test@example.iam.gserviceaccount.com",private_key:privateKey.export({type:"pkcs8",format:"pem"})});
 process.env.ORCHESTRATOR_AUDIT_WRITES_ENABLED="true";
 process.env.ORCHESTRATOR_GOOGLE_WRITER_SERVICE_ACCOUNT_JSON=account;
 process.env.ORCHESTRATOR_GOOGLE_SERVICE_ACCOUNT_JSON=account;
 process.env.ORCHESTRATOR_AUDIT_OUTPUT_FOLDER_IDS="audit";
 let outside=false,stale=false,writes=0;
 const urls:string[]=[];
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)); urls.push(url.href);
  if(url.href==="https://oauth2.googleapis.com/token")return Response.json({access_token:"synthetic-token"});
  if(url.origin==="https://www.googleapis.com"){
   assert.equal(url.searchParams.get("supportsAllDrives"),"true");
   assert.match(url.searchParams.get("fields")??"",/capabilities\(canEdit\)/);
   if(url.pathname==="/drive/v3/files/audit")return Response.json({id:"audit",mimeType:"application/vnd.google-apps.folder",parents:[outside?"other":"matter"]});
   assert.equal(url.pathname,"/drive/v3/files/doc");
   return Response.json({id:"doc",mimeType:"application/vnd.google-apps.document",parents:["audit"],capabilities:{canEdit:true}});
  }
  assert.equal(url.origin,"https://docs.googleapis.com");
  if(url.pathname==="/v1/documents/doc:batchUpdate"){
   writes++; assert.equal(init?.method,"POST");
   assert.deepEqual(JSON.parse(String(init?.body)).writeControl,{requiredRevisionId:"r1"});
   return Response.json({});
  }
  assert.equal(url.pathname,"/v1/documents/doc");
  return Response.json({...tracker,documentId:"doc",revisionId:stale?"r2":"r1"});
 };
 const input={documentId:"doc",matterFolderId:"matter",auditFolderId:"audit",expectedRevision:"r1",requests:[{insertText:{location:{index:285},text:"Verified"}}]};
 try{
  assert.equal((await AuditGoogleDocs.update(input)).documentId,"doc");assert.equal(writes,1);
  outside=true;await assert.rejects(AuditGoogleDocs.update(input),/outside the authorized/);assert.equal(writes,1);
  outside=false;stale=true;await assert.rejects(AuditGoogleDocs.update(input),/changed during/);assert.equal(writes,1);
  stale=false;await assert.rejects(AuditGoogleDocs.update({...input,requests:[{insertText:{location:{index:225},text:"overwrite"}}]}),/human-controlled/);assert.equal(writes,1);
  assert.ok(urls.some(url=>new URL(url).pathname==="/drive/v3/files/audit"));
 }finally{
  globalThis.fetch=originalFetch;
  for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
 }
});
