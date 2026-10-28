import type {CooMessage} from './delivery-store.ts';
import {sendGmail} from '../orchestrator/gmail-sender.ts';
import {senderOAuthReadiness} from '../orchestrator/sender-oauth.ts';
import {AUDIT_MAILBOX} from '../orchestrator/google-audit-constants.ts';
type SenderCheck=()=>Promise<{configured:boolean;connected:boolean;email:string|null}>;
export async function cooSendReadiness(env:NodeJS.ProcessEnv=process.env,check:SenderCheck=senderOAuthReadiness){
 const provider=env.ORCHESTRATOR_COO_EMAIL_PROVIDER??(env.ORCHESTRATOR_COO_RESEND_API_KEY?'resend':'gmail');
 if(env.ORCHESTRATOR_COO_SEND_ENABLED!=='true')return {enabled:false,provider,message:'COO sending is disabled in this environment. No client notice will be sent.'};
 if(provider==='gmail'){
  const sender=(env.ORCHESTRATOR_COO_FROM??'').match(/<([^<>]+)>/)?.[1]??env.ORCHESTRATOR_COO_FROM;
  if(sender?.toLowerCase()!==AUDIT_MAILBOX)return {enabled:false,provider,message:'Configure the approved communication mailbox as the COO sender before generating a new review.'};
  const connection=await check().catch(()=>null);
  const enabled=!!connection&&connection.configured&&connection.connected&&connection.email===AUDIT_MAILBOX;
  return {enabled,provider,message:enabled?'Gmail sender connected.':'Connect the approved Gmail sender in Settings before sending.'};
 }
 const enabled=provider==='resend'&&!!env.ORCHESTRATOR_COO_RESEND_API_KEY&&!!env.ORCHESTRATOR_COO_FROM;
 return {enabled,provider,message:enabled?'Resend sender configured.':'COO sending requires a verified firm sender and private email-provider configuration.'};
}
export async function sendCooMessage(message:CooMessage,key:string){
 if(message.from!==process.env.ORCHESTRATOR_COO_FROM)throw Error('The configured sender changed. Generate a new review before approval.');
 const readiness=await cooSendReadiness();if(!readiness.enabled)throw Error(readiness.message);
 const attachment={filename:message.packet.filename,content:message.packet.pdfBase64};
 if(readiness.provider==='gmail')return sendGmail({to:message.to,cc:message.cc,subject:message.subject,text:message.text,attachments:[attachment]},key);
 const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.ORCHESTRATOR_COO_RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({from:message.from,to:message.to,...(message.cc.length?{cc:message.cc}:{}),subject:message.subject,text:message.text,attachments:[attachment]}),signal:AbortSignal.timeout(20000)});
 const result=await response.json();if(!response.ok||typeof result.id!=='string')throw Error(`The email provider did not confirm acceptance (HTTP ${response.status}).`);return {id:result.id};
}
