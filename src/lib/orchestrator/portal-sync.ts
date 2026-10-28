import {documentBackend,changeHostedDocument} from './hosted/document.ts';
import {getSnapshot} from './store.ts';
import {synchronizePortalMilestone,type PortalReceipt} from './portal-milestones.ts';
export interface PortalSyncRecord{status:'verified'|'attention';at:string;retryAt?:string;receipt?:{milestoneIds:string[];stageId:string;verifiedAt:string};}
/** Delivery and portal reconciliation are independent. This never invokes an email sender. */
export async function runPortalSync(){
 if(process.env.ORCHESTRATOR_PORTAL_SYNC_ENABLED!=='true')return {enabled:false};
 const source=await documentBackend().read<Record<string,PortalReceipt>>('mortgage-email-tests');
 const prior=await documentBackend().read<Record<string,PortalSyncRecord>>('portal-sync');
 const pending=Object.entries(source?.value??{}).filter(([key,r])=>r.mode==='client'&&r.status==='sent'&&['mortgage','funds'].includes(r.kind??'')&&prior?.value[key]?.status!=='verified'&&(!prior?.value[key]?.retryAt||Date.parse(prior.value[key].retryAt!)<=Date.now()));
 if(!pending.length)return {enabled:true,updated:0};const snapshot=await getSnapshot();let updated=0;
 for(const [key,r] of pending){try{const matter=snapshot.matters.find(m=>m.id===r.fileId);if(!matter)throw Error('File not found.');const receipt=await synchronizePortalMilestone(matter,r);await changeHostedDocument<Record<string,PortalSyncRecord>,void>('portal-sync',()=>({}),s=>{s[key]={status:'verified',at:new Date().toISOString(),receipt};});updated++;}catch{await changeHostedDocument<Record<string,PortalSyncRecord>,void>('portal-sync',()=>({}),s=>{s[key]={status:'attention',at:s[key]?.at??new Date().toISOString(),retryAt:new Date(Date.now()+300000).toISOString()};});}}
 return {enabled:true,updated};
}
