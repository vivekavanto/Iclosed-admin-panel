import {createHash} from 'node:crypto';
import {documentBackend,requireHostedBaseline} from './hosted/document.ts';
import {getHostedBlob} from './hosted/blob.ts';
import {teamTransaction,deliverTeamEvent,SlackRejected,type TeamEvent} from './team-events.ts';
import type {AuditJob} from './audit-model.ts';
import type {CooReview} from '../coo/delivery-store.ts';
const TEAM='T061ZJFUH5X';
export async function collectTeamEvents(){
 await requireHostedBaseline();const startedAt=await teamTransaction(s=>s.startedAt),events:TeamEvent[]=[];
 const backend=documentBackend();
 const audits=await backend.read<{jobs:AuditJob[]}>('audit-jobs');
 for(const j of audits?.value.jobs??[])if(['completed','failed'].includes(j.status)&&j.updatedAt>=startedAt)events.push({id:`audit:${j.id}:${j.status}`,workflow:'audit',outcome:j.status==='completed'?'completed':'attention',requester:j.actor,fileId:j.matterId,fileNumber:j.matterNumber,at:j.updatedAt});
 const coo=await backend.read<{reviews:Record<string,{status:string;createdAt:string;sentAt?:string}>;payloads?:Record<string,string>}>('coo');
 for(const [id,summary] of Object.entries(coo?.value.reviews??{})){
  if(!['sent','uncertain'].includes(summary.status))continue;
  const hash=coo?.value.payloads?.[id];if(!hash)continue;const r=JSON.parse((await getHostedBlob(hash)).toString('utf8')) as CooReview;
  if((r.sentAt??r.approval?.at??r.createdAt)<startedAt)continue;
  events.push({id:`coo:${r.id}:${r.status}`,workflow:'coo',outcome:r.status==='sent'?'sent':'attention',requester:r.approval?.actor??r.author,fileId:r.fileId,fileNumber:r.draft.fileNumber,at:r.sentAt??r.approval?.at??r.createdAt});
 }
 const runtime=await backend.read<{jobs:{id:string;status:string;createdAt:string;context?:{requester:string;fileId?:string;fileNumber?:string;workflow:'coo'|'other'}}[]}>('runtime');
 for(const j of runtime?.value.jobs??[])if(j.status==='failed'&&j.createdAt>=startedAt&&j.context)events.push({id:'runtime:'+j.id,workflow:j.context.workflow,outcome:'attention',requester:j.context.requester,fileId:j.context.fileId,fileNumber:j.context.fileNumber,at:j.createdAt});
 const intake=await backend.read<{'requests.json'?:{id:string;status:string;updatedAt:string;requester:string;blockers:string[]}[]}>('email-intake');
 for(const r of intake?.value['requests.json']??[])if(r.status==='approved_blocked'&&r.blockers.length&&r.updatedAt>=startedAt)events.push({id:`opening:${r.id}:${r.updatedAt}`,category:'file-opening',workflow:'other',outcome:'attention',requester:r.requester,at:r.updatedAt});
 const portal=await backend.read<Record<string,{status:string;at:string}>>('portal-sync');
 const emails=await backend.read<Record<string,{status:string;mode?:string;createdAt:string;fileId:string;operator:string}>>('mortgage-email-tests');
 for(const [id,r] of Object.entries(emails?.value??{}))if(r.mode==='client'&&r.status==='uncertain'&&r.createdAt>=startedAt)events.push({id:'email:'+id,category:'email-delivery',workflow:'other',outcome:'attention',requester:r.operator,at:r.createdAt});
 for(const [id,r] of Object.entries(portal?.value??{})){const source=emails?.value[id];if(r.status==='attention'&&source&&r.at>=startedAt)events.push({id:'portal:'+id,category:'portal-sync',workflow:'other',outcome:'attention',requester:source.operator,at:r.at});}
 await teamTransaction(s=>{for(const event of events)if(!s.deliveries[event.id])s.deliveries[event.id]={event,status:'pending'};for(const d of Object.values(s.deliveries))if(d.status==='sending'&&Date.now()-Date.parse(d.startedAt??'')>120000){d.status='uncertain';d.error='Interrupted Slack delivery requires receipt reconciliation.';}});
 return teamTransaction(s=>Object.values(s.deliveries).filter(d=>['pending','blocked'].includes(d.status)&&(!d.retryAt||Date.parse(d.retryAt)<=Date.now())).map(d=>d.event.id));
}
export async function slackCall(method:string,body:Record<string,unknown>){
 const token=process.env.ORCHESTRATOR_SLACK_BOT_TOKEN;if(!token)throw Error('Slack bot is not connected.');
 const lookup=method==='users.lookupByEmail';
 const response=await fetch('https://slack.com/api/'+method+(lookup?'?'+new URLSearchParams(body as Record<string,string>):''),{method:lookup?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json; charset=utf-8'},...(lookup?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 if(response.status===429)throw new SlackRejected('Slack rate limit.');const result=await response.json();if(result.ok===false)throw new SlackRejected('Slack rejected the request.');if(!response.ok||result.ok!==true)throw Error('Slack request was not confirmed.');return result;
}
const users=new Map<string,string>();
export async function resolveSlackRequester(actor:string){
 if(users.has(actor))return users.get(actor)!;let email=actor;
 if(!email.includes('@')){
  if(!/^[0-9a-f-]{36}$/i.test(actor))throw Error('Invalid workflow requester.');
  const {hostedConfiguration}=await import('./hosted/document.ts');const c=hostedConfiguration()!;
  const response=await fetch(c.url+'/auth/v1/admin/users/'+actor,{headers:{apikey:c.key,Authorization:'Bearer '+c.key},signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Requester account unavailable.');email=(await response.json()).email;
 }
 if(typeof email!=='string'||!email.toLowerCase().endsWith('@navawilson.law'))throw Error('Requester must be a verified staff account.');
 const result=await slackCall('users.lookupByEmail',{email});const id=result.user?.id;
 if(!/^U[A-Z0-9]+$/.test(id??''))throw Error('Requester Slack identity unavailable.');users.set(actor,id);return id as string;
}
export async function verifySlackConnection(){const result=await slackCall('auth.test',{});if(result.team_id!==TEAM)throw Error('Connect the verified Nava Wilson Slack workspace.');return true;}
export function notificationMessageId(id:string){const hex=createHash('sha256').update(id).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
export async function runTeamNotifications(){
 if(process.env.ORCHESTRATOR_SLACK_ENABLED!=='true')return {enabled:false};
 await verifySlackConnection();const ids=await collectTeamEvents();let sent=0;
 for(const id of ids.slice(0,20)){const result=await deliverTeamEvent(id,resolveSlackRequester,async(event,message)=>slackCall('chat.postMessage',{...message,client_msg_id:notificationMessageId(event.id)}),process.env.ORCHESTRATOR_APP_URL??'');if(result.sent)sent++;}
 return {enabled:true,sent};
}
