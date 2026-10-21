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
