import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {hostedDocumentsEnabled,changeHostedDocument} from './hosted/document.ts';
import {localStateDirectory} from './local-store.ts';
export type TeamEvent={id:string;workflow:'audit'|'coo'|'other';outcome:'completed'|'sent'|'attention';requester:string;fileId?:string;fileNumber?:string;category?:'portal-sync'|'email-delivery'|'file-opening'|'closer-sync'|'mail-discovery';at:string};
export type TeamDelivery={event:TeamEvent;status:'pending'|'sending'|'sent'|'uncertain'|'blocked';attempt?:string;startedAt?:string;ts?:string;channel?:string;error?:string;retryAt?:string};
export interface TeamState{startedAt:string;deliveries:Record<string,TeamDelivery>;health?:{at:string;slackEnabled:boolean;portalEnabled:boolean};}
export async function teamTransaction<T>(fn:(state:TeamState)=>T):Promise<T>{
 const initial=():TeamState=>({startedAt:new Date().toISOString(),deliveries:{}});
 if(hostedDocumentsEnabled())return changeHostedDocument('team-notifications',initial,fn);
 const root=localStateDirectory();if(!root)throw Error('Private notification storage is not configured.');
 await mkdir(root,{recursive:true,mode:0o700});const lock=path.join(root,'.team-notifications-lock');await mkdir(lock,{mode:0o700});const file=path.join(root,'team-notifications.json'),temp=path.join(root,`.team-${randomUUID()}.tmp`);
 try{let state;try{state=JSON.parse(await readFile(file,'utf8')) as TeamState;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state=initial();}const result=fn(state);await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,file);return result;}finally{await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}
}
export const TEAM_CHANNELS={audit:'C0C2TM67LFP',coo:'C0C4RKGFY4W',other:'C0BUV1RNTMF'} as const;
export const SARU_SLACK_ID='U0629UW3YN4';
export function teamMessage(event:TeamEvent,requesterId:string,origin:string){
 if(!/^U[A-Z0-9]+$/.test(requesterId))throw Error('Requester Slack identity is missing.');
 if(!['https://admin.iclosed.ca','https://devadmin.iclosed.ca'].includes(origin))throw Error('Select an approved notification origin.');
 const mentions=[...new Set(event.workflow==='other'?[SARU_SLACK_ID,requesterId]:[requesterId])].map(id=>`<@${id}>`).join(' ');
 const categoryTitle=event.category==='portal-sync'?'Email delivered; portal milestone needs attention (do not resend the email)':event.category==='email-delivery'?'Client email delivery needs reconciliation':event.category==='file-opening'?'File opening needs attention':undefined;
 const title=categoryTitle??(event.workflow==='audit'?(event.outcome==='completed'?'Signing audit completed':'Signing audit needs attention'):event.workflow==='coo'?(event.outcome==='sent'?'COO sent':'COO needs attention'):'Workflow needs attention');
 const number=event.fileNumber?.replace(/[^a-zA-Z0-9-]/g,'').slice(0,24);
 const suffix=event.fileId&&event.workflow!=='other'?`/files/${encodeURIComponent(event.fileId)}/${event.workflow==='audit'?'audit':'coo'}`:'';
 return {channel:TEAM_CHANNELS[event.workflow],text:`${origin.includes('devadmin')?'[DEV TEST] ':''}${mentions} ${title}${number?' — '+number:''}. <${origin}/admin/legal-assistant${suffix}|Open in iClosed>`,unfurl_links:false,unfurl_media:false};
}
/** Claim before posting. Unknown provider outcomes never get blindly retried. */
export async function deliverTeamEvent(id:string,resolve:(actor:string)=>Promise<string>,post:(event:TeamEvent,message:ReturnType<typeof teamMessage>)=>Promise<{ts:string;channel:string}>,origin:string){
 const entry=await teamTransaction(s=>s.deliveries[id]);if(!entry||!['pending','blocked'].includes(entry.status)||(entry.retryAt&&Date.parse(entry.retryAt)>Date.now()))return {skipped:true};
 let userId;try{userId=await resolve(entry.event.requester);}catch{await teamTransaction(s=>{if(['pending','blocked'].includes(s.deliveries[id].status)){s.deliveries[id].status='blocked';s.deliveries[id].error='Requester identity could not be resolved.';s.deliveries[id].retryAt=new Date(Date.now()+300000).toISOString();}});return {blocked:true};}
 const message=teamMessage(entry.event,userId,origin),attempt=randomUUID();
 const claimed=await teamTransaction(s=>{const d=s.deliveries[id];if(!['pending','blocked'].includes(d.status)||(d.retryAt&&Date.parse(d.retryAt)>Date.now()))return false;d.status='sending';d.attempt=attempt;d.startedAt=new Date().toISOString();return true;});if(!claimed)return {skipped:true};
 try{const receipt=await post(entry.event,message);if(!receipt.ts||receipt.channel!==message.channel)throw Error('Missing Slack receipt.');await teamTransaction(s=>{const d=s.deliveries[id];if(d.attempt!==attempt)throw Error('Notification claim changed.');d.status='sent';d.ts=receipt.ts;d.channel=receipt.channel;});return {sent:true};}
 catch(error){const rejected=error instanceof SlackRejected;await teamTransaction(s=>{const d=s.deliveries[id];if(d.attempt===attempt){d.status=rejected?'blocked':'uncertain';d.error=rejected?'Slack rejected delivery; configuration or rate-limit attention required.':'Slack delivery needs receipt reconciliation before retry.';if(rejected)d.retryAt=new Date(Date.now()+300000).toISOString();}});return rejected?{blocked:true}:{uncertain:true};}
}

/** Stable incident IDs suppress repeated alerts for an unchanged failure. */
export async function recordTeamIntervention(id:string,workflow:TeamEvent['workflow'],requester:string,fileId?:string,fileNumber?:string){
 if(process.env.ORCHESTRATOR_SLACK_ENABLED!=='true')return;
 await teamTransaction(s=>{if(!s.deliveries[id])s.deliveries[id]={event:{id,workflow,outcome:'attention',requester,fileId,fileNumber,at:new Date().toISOString()},status:'pending'};});
}

/** Only a definite negative provider response permits a safe future post attempt. */
export class SlackRejected extends Error {}
