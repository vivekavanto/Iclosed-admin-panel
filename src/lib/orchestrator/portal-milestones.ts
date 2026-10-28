import {hostedConfiguration,hostedDocumentsEnabled} from './hosted/document.ts';
import type {Matter} from './model.ts';
export type PortalReceipt={fileId:string;kind?:string;mode?:string;status:string;sentAt?:string;receipts?:{id:string}[]};
const names={purchase:{mortgage:'Mortgage Instructions',funds:'Lender Funds Received'},refinance:{mortgage:'Financing -> Mortgage Instructions & Review of Mortgage Terms',funds:'Funds Release by the Lender'}} as const;
const normalized=(text:string)=>text.trim().replace(/\s+/g,' ').toLowerCase();
export function portalStageName(matter:Pick<Matter,'type'>,receipt:PortalReceipt){
 if(receipt.mode!=='client'||receipt.status!=='sent'||!receipt.sentAt||!Number.isFinite(Date.parse(receipt.sentAt))||!receipt.receipts?.length||receipt.receipts.some(r=>!r.id))throw Error('Portal updates require confirmed client delivery receipts.');
 if(!['mortgage','funds'].includes(receipt.kind??'')||matter.type==='sale')throw Error('This notification has no receipt milestone.');
 return names[matter.type][receipt.kind as 'mortgage'|'funds'];
}
export function portalDealTypeMatches(type:string,matterType:Matter['type']){const value=normalized(type);return value===matterType||(matterType==='purchase'&&value==='purchase & sale');}
export function selectPortalStage(stages:{id:string;name:string;lead_type:string;is_deleted?:boolean}[],matter:Pick<Matter,'type'>,receipt:PortalReceipt){
 const name=portalStageName(matter,receipt),matches=stages.filter(s=>!s.is_deleted&&normalized(s.name)===normalized(name)&&normalized(s.lead_type)===matter.type);
 if(matches.length!==1)throw Error('The portal receipt milestone mapping is missing or ambiguous.');return matches[0].id;
}
/** Only receipt milestones change. Never cascade to tasks or emit another email. */
export async function synchronizePortalMilestone(matter:Matter,receipt:PortalReceipt){
 portalStageName(matter,receipt);
 if(process.env.ORCHESTRATOR_PORTAL_SYNC_ENABLED!=='true'||!hostedDocumentsEnabled())throw Error('Portal synchronization is not enabled for this environment.');
 const config=hostedConfiguration()!;
 const request=async(table:string,query:Record<string,string>,init:RequestInit={})=>{const r=await fetch(config.url+'/rest/v1/'+table+'?'+new URLSearchParams(query),{...init,headers:{apikey:config.key,Authorization:'Bearer '+config.key,'Content-Type':'application/json',Prefer:'return=representation'},signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Portal synchronization could not be confirmed.');return r.json();};
 const stages=await request('stage_templates',{select:'id,name,lead_type,is_deleted',is_deleted:'eq.false'});const stageId=selectPortalStage(stages,matter,receipt);
 const compact=matter.number.replace(/-/g,'');if(!(matter.type==='purchase'?/^\d{2}P\d{4}$/:/^\d{2}R\d{4}$/).test(compact))throw Error('A verified file number is required for portal matching.');
 const numbers=[compact,compact.slice(0,3)+'-'+compact.slice(3)];
 const all=await request('deals',{select:'id,file_number,type,lead_id',file_number:'in.('+numbers.join(',')+')',is_deleted:'eq.false'});
 const deals=all.filter((d:{type:string})=>portalDealTypeMatches(d.type,matter.type));if(!deals.length)throw Error('No matching portal deal was found.');
 const leads=await request('leads',{select:'id,parent_lead_id',id:'in.('+deals.map((d:{lead_id:string})=>d.lead_id).join(',')+')',is_deleted:'eq.false'});
 const roots=new Set(leads.map((l:{id:string;parent_lead_id:string|null})=>l.parent_lead_id??l.id));if(roots.size!==1||leads.length!==new Set(deals.map((d:{lead_id:string})=>d.lead_id)).size)throw Error('Portal file matching is ambiguous.');
 const rows=await request('milestones',{select:'id,deal_id,status,completed_at,email_sent',deal_id:'in.('+deals.map((d:{id:string})=>d.id).join(',')+')',stage_template_id:'eq.'+stageId,is_deleted:'eq.false'});
 if(rows.length!==deals.length||new Set(rows.map((m:{deal_id:string})=>m.deal_id)).size!==deals.length)throw Error('A receipt milestone is missing or duplicated on this portal family.');
 const tasks=await request('tasks',{select:'id',milestone_id:'in.('+rows.map((m:{id:string})=>m.id).join(',')+')',limit:'1'});if(tasks.length)throw Error('Receipt milestone has linked tasks; manual review is required before completing it.');
 for(const row of rows){if(row.status==='Completed'&&row.email_sent)continue;await request('milestones',{id:'eq.'+row.id,deal_id:'eq.'+row.deal_id,stage_template_id:'eq.'+stageId,is_deleted:'eq.false'},{method:'PATCH',body:JSON.stringify({status:'Completed',completed_at:row.completed_at??receipt.sentAt,email_sent:true})});}
 const saved=await request('milestones',{select:'id,status,completed_at,email_sent',id:'in.('+rows.map((m:{id:string})=>m.id).join(',')+')'});
 if(saved.length!==rows.length||saved.some((m:{status:string;completed_at:string;email_sent:boolean})=>m.status!=='Completed'||!m.completed_at||!m.email_sent))throw Error('Portal milestone readback failed.');
 return {milestoneIds:saved.map((m:{id:string})=>m.id),stageId,verifiedAt:new Date().toISOString()};
}
