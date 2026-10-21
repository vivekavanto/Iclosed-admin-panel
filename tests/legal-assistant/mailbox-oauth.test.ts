import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beginMailboxOAuth, finishMailboxOAuth, readMailboxConnection, validMailboxState, mailboxAppOrigin } from "../../src/lib/orchestrator/mailbox-oauth.ts";
import { GMAIL_READ_SCOPE } from "../../src/lib/orchestrator/google-audit-constants.ts";
async function fixture(run:(root:string)=>Promise<void>) {
 const root=await mkdtemp(path.join(os.tmpdir(),"mailbox-oauth-"));const names=["ORCHESTRATOR_LOCAL_STATE_DIR","ORCHESTRATOR_APP_URL","ORCHESTRATOR_GMAIL_CLIENT_ID","ORCHESTRATOR_GMAIL_CLIENT_SECRET","ORCHESTRATOR_TOKEN_ENCRYPTION_KEY","NODE_ENV"];const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));const oldFetch=globalThis.fetch;
 Object.assign(process.env,{ORCHESTRATOR_LOCAL_STATE_DIR:root,ORCHESTRATOR_APP_URL:"http://127.0.0.1:3002",ORCHESTRATOR_GMAIL_CLIENT_ID:"test.apps.googleusercontent.com",ORCHESTRATOR_GMAIL_CLIENT_SECRET:"test-secret",NODE_ENV:"test"});delete process.env.ORCHESTRATOR_TOKEN_ENCRYPTION_KEY;
 try {await run(root);}finally{globalThis.fetch=oldFetch;for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(root,{recursive:true,force:true});}
}
const okToken={access_token:"access-test",refresh_token:"refresh-test-secret",scope:GMAIL_READ_SCOPE};
const response=(v:object)=>new Response(JSON.stringify(v),{status:200,headers:{"Content-Type":"application/json"}});
test("consent asks only for read-only Gmail, with PKCE and a fixed callback",async()=>fixture(async()=>{
 const attempt=await beginMailboxOAuth("manager");const u=new URL(attempt.url);assert.equal(u.origin,"https://accounts.google.com");assert.equal(u.searchParams.get("scope"),GMAIL_READ_SCOPE);assert.equal(u.searchParams.get("redirect_uri"),"http://127.0.0.1:3002/api/admin/legal-assistant/mailbox/callback");assert.equal(u.searchParams.get("code_challenge_method"),"S256");assert.equal(u.searchParams.get("include_granted_scopes"),"false");assert.equal(u.searchParams.get("login_hint"),"communication@navawilson.law");assert.match(attempt.state,/^[\w-]{43}$/);assert.ok(!attempt.url.includes("test-secret"));
}));
test("invalid state and replay cannot reach Google",async()=>fixture(async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error("Unexpected network call");};const a=await beginMailboxOAuth("manager");
 await assert.rejects(finishMailboxOAuth({operatorId:"manager",cookieState:a.state,returnedState:"bad",code:"code"}),/state/);
 await assert.rejects(finishMailboxOAuth({operatorId:"manager",cookieState:a.state,returnedState:a.state,code:null,denied:true}),/cancelled/);
 await assert.rejects(finishMailboxOAuth({operatorId:"manager",cookieState:a.state,returnedState:a.state,code:"code"}),/already used/);assert.equal(calls,0);
}));
test("another administrator cannot finish an existing attempt",async()=>fixture(async()=>{
 const a=await beginMailboxOAuth("manager-one");await assert.rejects(finishMailboxOAuth({operatorId:"manager-two",cookieState:a.state,returnedState:a.state,code:"code"}),/another administrator/);assert.equal(await readMailboxConnection(),null);
}));
test("expired attempt is rejected before token exchange",async()=>fixture(async()=>{
 const a=await beginMailboxOAuth("manager"),now=Date.now;Date.now=()=>now()+11*60_000;
 try{await assert.rejects(finishMailboxOAuth({operatorId:"manager",cookieState:a.state,returnedState:a.state,code:"code"}),/expired/);}finally{Date.now=now;}
}));
test("wrong mailbox and broader scopes are never persisted",async()=>fixture(async()=>{
 globalThis.fetch=async(input)=>String(input).includes("oauth2")?response(okToken):response({emailAddress:"saru@navawilson.law"});const a=await beginMailboxOAuth("manager");
 await assert.rejects(finishMailboxOAuth({operatorId:"manager",cookieState:a.state,returnedState:a.state,code:"code"}),/Please authorize communication/);assert.equal(await readMailboxConnection(),null);
 globalThis.fetch=async()=>response({...okToken,scope:GMAIL_READ_SCOPE+" https://www.googleapis.com/auth/gmail.modify"});const b=await beginMailboxOAuth("manager");
 await assert.rejects(finishMailboxOAuth({operatorId:"manager",cookieState:b.state,returnedState:b.state,code:"code"}),/exactly/);assert.equal(await readMailboxConnection(),null);
}));
test("verified refresh token is encrypted at rest and state is single-use",async()=>fixture(async(root)=>{
 let exchanges=0;globalThis.fetch=async(input,init)=>{if(String(input).includes("oauth2")){exchanges++;const body=init?.body as URLSearchParams;assert.ok(body.get("code_verifier"));assert.equal(body.get("client_secret"),"test-secret");return response(okToken);}return response({emailAddress:"communication@navawilson.law"});};
 const a=await beginMailboxOAuth("manager");await finishMailboxOAuth({operatorId:"manager",cookieState:a.state,returnedState:a.state,code:"code"});const saved=await readMailboxConnection();assert.equal(saved?.email,"communication@navawilson.law");assert.equal(saved?.refreshToken,okToken.refresh_token);
 const raw=await readFile(path.join(root,"mailbox-connection","connection.json"),"utf8");assert.ok(!raw.includes(okToken.refresh_token));assert.ok(!raw.includes("communication@navawilson.law"));
 await assert.rejects(finishMailboxOAuth({operatorId:"manager",cookieState:a.state,returnedState:a.state,code:"code"}),/already used/);assert.equal(exchanges,1);
}));
test("origins and state strings cannot point the connection off-site",async()=>fixture(async()=>{
 assert.equal(validMailboxState("../../connection","../../connection"),false);process.env.ORCHESTRATOR_APP_URL="http://evil.example";assert.throws(mailboxAppOrigin,/origin/);process.env.ORCHESTRATOR_APP_URL="https://files.iclosed.ca/other";assert.throws(mailboxAppOrigin,/origin/);
}));
