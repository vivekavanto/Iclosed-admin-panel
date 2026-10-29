import {CLIENT_NOTIFICATION_REPLY_TO} from './client-email-contact.ts';
import {internalNotificationTestHtml} from './notification-email-layout.ts';
import {hostedDocumentsEnabled,changeHostedDocument} from "./hosted/document.ts";
import {mkdir,readFile,writeFile,rename,rm} from "node:fs/promises";
import path from "node:path";import {randomUUID,createHash} from "node:crypto";
import {localStateDirectory} from "./local-store.ts";
import {MORTGAGE_TEST_RECIPIENT,type MortgageEmailPreview} from "./mortgage-email.ts";
import {gmailMime,type OutgoingEmail} from "./gmail-sender.ts";
interface TestReceipt{kind?:string;mode?:string;approvalHash?:string;to?:string[];cc?:string[];receipts?:{id:string;messageId?:string}[];fileId:string;hash:string;operator:string;requestId:string;status:'sending'|'sent'|'uncertain';createdAt:string;sentAt?:string;providerId?:string;messageId?:string;}
type State=Record<string,TestReceipt>;
function root(){const base=localStateDirectory();if(!base)throw Error('Persistent email test storage is not configured.');return base;}
async function locked<T>(fn:(state:State)=>T){if(hostedDocumentsEnabled())return changeHostedDocument<State,T>("mortgage-email-tests",()=>({}),fn);await mkdir(root(),{recursive:true,mode:0o700});const lock=path.join(root(),'.mortgage-email-lock');try{await mkdir(lock,{mode:0o700});}catch{throw Error('Another email test is being recorded. Retry after refreshing.');}try{let state:State={};try{state=JSON.parse(await readFile(path.join(root(),'mortgage-email-tests.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const result=fn(state),temp=path.join(root(),`.mortgage-email-${randomUUID()}.tmp`);await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,path.join(root(),'mortgage-email-tests.json'));return result;}finally{await rm(lock,{recursive:true,force:true});}}
export async function sendMortgageInternalTest(preview:Omit<MortgageEmailPreview,'senderConnected'>,requestId:string,operator:string,send:(email:OutgoingEmail,key:string)=>Promise<{id:string;messageId?:string}>){
 if(!/^[a-f0-9-]{36}$/.test(requestId))throw Error('A valid email test request ID is required.');
 const key=(preview.kind==='funds'?'funds-test-':'mortgage-test-')+createHash('sha256').update(operator+':'+requestId).digest('hex');
 const intent=await locked(state=>{const prior=state[key];if(prior){if(prior.hash!==preview.hash||prior.fileId!==preview.fileId)throw Error('The email preview changed. Reopen it before sending.');if(prior.status!=='sent')throw Error('This email test is in progress or needs reconciliation. Do not submit another copy.');return {prior,duplicate:true};}const created:TestReceipt={fileId:preview.fileId,hash:preview.hash,operator,requestId,status:'sending',createdAt:new Date().toISOString()};state[key]=created;return {prior:created,duplicate:false};});
 if(intent.duplicate)return {...intent.prior,duplicate:true};
 try{const result=await send({replyTo:CLIENT_NOTIFICATION_REPLY_TO,to:[MORTGAGE_TEST_RECIPIENT],subject:preview.subject,html:preview.html,text:preview.text},key);if(!result.id)throw Error('No send receipt.');return await locked(state=>{const receipt=state[key];receipt.status='sent';receipt.sentAt=new Date().toISOString();receipt.providerId=result.id;receipt.messageId=result.messageId;return {...receipt,duplicate:false};});}catch{await locked(state=>{state[key].status='uncertain';});throw Error('The email test outcome could not be confirmed. Check the shared mailbox before retrying.');}
}

export function emailTestRecipient(env:NodeJS.ProcessEnv=process.env){
 const to=env.ORCHESTRATOR_EMAIL_TEST_RECIPIENT??MORTGAGE_TEST_RECIPIENT;
 if(!['saru@navawilson.law',MORTGAGE_TEST_RECIPIENT].includes(to))throw Error('Configure an approved internal test recipient.');
 return to;
}
/** Provider actions stay outside the transaction. Uncertain delivery cannot be retried automatically. */
export async function sendReviewedMessages(input:{fileId:string;kind:'mortgage'|'funds'|'coo';mode:'client'|'test';approvalHash:string;requestId:string;operator:string;messages:OutgoingEmail[]},send:(email:OutgoingEmail,key:string)=>Promise<{id:string;messageId?:string}>){
 if(!['client','test'].includes(input.mode)||!['mortgage','funds','coo'].includes(input.kind)||!/^[a-f0-9-]{36}$/.test(input.requestId)||!input.messages.length||input.messages.length>3)throw Error('Invalid reviewed email request.');
 if(input.kind==='coo'&&input.mode==='client')throw Error('COO live delivery requires its dedicated approval workflow.');
 if(input.mode==='client'&&process.env.ORCHESTRATOR_CLIENT_SEND_ENABLED!=='true')throw Error('Client email sending is disabled.');
 const messages=input.messages.map(message=>{const m=input.kind==='coo'?message:{...message,replyTo:CLIENT_NOTIFICATION_REPLY_TO};return input.mode==='test'?{...m,to:[emailTestRecipient()],cc:[],subject:'[INTERNAL TEST] '+m.subject,text:'INTERNAL TEST ONLY — no client notice has been sent.\n\n'+m.text,html:m.html?internalNotificationTestHtml(m.html):undefined}:m;});
 // Validate before persisting an intent or contacting the provider.
 for(const message of messages)gmailMime(message,'validation');
 const hash=createHash('sha256').update(JSON.stringify({approvalHash:input.approvalHash,messages})).digest('hex');
 const key='reviewed-'+createHash('sha256').update(input.mode+':'+input.kind+':'+input.fileId+(input.mode==='test'?':'+input.operator+':'+input.requestId:'')).digest('hex');
 const intent=await locked(state=>{const prior=state[key];if(prior){if(prior.hash!==hash)throw Error('A different email revision already exists. Review the delivery history before resending.');if(prior.status!=='sent')throw Error('Delivery is in progress or requires reconciliation. Do not send another copy.');return {receipt:prior,duplicate:true};}const receipt:TestReceipt={fileId:input.fileId,kind:input.kind,mode:input.mode,approvalHash:input.approvalHash,hash,operator:input.operator,requestId:input.requestId,status:'sending',createdAt:new Date().toISOString(),to:messages.flatMap(m=>m.to),cc:messages.flatMap(m=>m.cc??[]),receipts:[]};state[key]=receipt;return {receipt,duplicate:false};});
 if(intent.duplicate)return {...intent.receipt,duplicate:true};
 try{for(let i=0;i<messages.length;i++){const result=await send(messages[i],key+'-'+i);if(!result.id)throw Error('Missing provider receipt.');await locked(state=>{state[key].receipts!.push(result);});}return await locked(state=>{const receipt=state[key];receipt.status='sent';receipt.sentAt=new Date().toISOString();return {...receipt,duplicate:false};});}catch{await locked(state=>{state[key].status='uncertain';});throw Error('Delivery could not be confirmed. Reconcile provider receipts before retrying.');}
}
export async function clientNotificationSummaries(){return locked(state=>Object.values(state).filter(r=>r.mode==='client'&&r.status==='sent'&&r.sentAt).reduce<Record<string,{mortgage?:string;funds?:string}>>((all,r)=>{if(r.kind==='mortgage'||r.kind==='funds')(all[r.fileId]??={})[r.kind]=r.sentAt;return all;},{}));}
