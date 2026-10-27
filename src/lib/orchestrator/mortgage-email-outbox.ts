import {hostedDocumentsEnabled,changeHostedDocument} from "./hosted/document.ts";
import {mkdir,readFile,writeFile,rename,rm} from "node:fs/promises";
import path from "node:path";import {randomUUID,createHash} from "node:crypto";
import {localStateDirectory} from "./local-store.ts";
import {MORTGAGE_TEST_RECIPIENT,type MortgageEmailPreview} from "./mortgage-email.ts";
import type {OutgoingEmail} from "./gmail-sender.ts";
interface TestReceipt{fileId:string;hash:string;operator:string;requestId:string;status:'sending'|'sent'|'uncertain';createdAt:string;sentAt?:string;providerId?:string;messageId?:string;}
type State=Record<string,TestReceipt>;
function root(){const base=localStateDirectory();if(!base)throw Error('Persistent email test storage is not configured.');return base;}
async function locked<T>(fn:(state:State)=>T){if(hostedDocumentsEnabled())return changeHostedDocument<State,T>("mortgage-email-tests",()=>({}),fn);await mkdir(root(),{recursive:true,mode:0o700});const lock=path.join(root(),'.mortgage-email-lock');try{await mkdir(lock,{mode:0o700});}catch{throw Error('Another email test is being recorded. Retry after refreshing.');}try{let state:State={};try{state=JSON.parse(await readFile(path.join(root(),'mortgage-email-tests.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const result=fn(state),temp=path.join(root(),`.mortgage-email-${randomUUID()}.tmp`);await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,path.join(root(),'mortgage-email-tests.json'));return result;}finally{await rm(lock,{recursive:true,force:true});}}
export async function sendMortgageInternalTest(preview:Omit<MortgageEmailPreview,'senderConnected'>,requestId:string,operator:string,send:(email:OutgoingEmail,key:string)=>Promise<{id:string;messageId?:string}>){
 if(!/^[a-f0-9-]{36}$/.test(requestId))throw Error('A valid email test request ID is required.');
 const key='mortgage-test-'+createHash('sha256').update(operator+':'+requestId).digest('hex');
 const intent=await locked(state=>{const prior=state[key];if(prior){if(prior.hash!==preview.hash||prior.fileId!==preview.fileId)throw Error('The email preview changed. Reopen it before sending.');if(prior.status!=='sent')throw Error('This email test is in progress or needs reconciliation. Do not submit another copy.');return {prior,duplicate:true};}const created:TestReceipt={fileId:preview.fileId,hash:preview.hash,operator,requestId,status:'sending',createdAt:new Date().toISOString()};state[key]=created;return {prior:created,duplicate:false};});
 if(intent.duplicate)return {...intent.prior,duplicate:true};
 try{const result=await send({to:[MORTGAGE_TEST_RECIPIENT],subject:preview.subject,html:preview.html,text:preview.text},key);if(!result.id)throw Error('No send receipt.');return await locked(state=>{const receipt=state[key];receipt.status='sent';receipt.sentAt=new Date().toISOString();receipt.providerId=result.id;receipt.messageId=result.messageId;return {...receipt,duplicate:false};});}catch{await locked(state=>{state[key].status='uncertain';});throw Error('The email test outcome could not be confirmed. Check the shared mailbox before retrying.');}
}
