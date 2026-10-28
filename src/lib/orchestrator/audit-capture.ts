import {auditMailBody,auditMailEvidenceText,type AuditMailPart} from "./audit-mail-content.ts";
import {auditMailQuery,verifiedAddressThread} from "./audit-mail-scope.ts";
import {readPdfInspection,savePdfInspection} from "./pdf-inspection-cache.ts";
import { spawn } from "node:child_process";
import path from "node:path";
import { ReadOnlyDrive, type DriveItem } from "./google-drive.ts";
import { AuditMailbox } from "./google-audit-mail.ts";
import { selectHistoricalMailEvidence } from "./audit-evidence.ts";
import { getAuditBlob, putAuditBlob, renewAuditLease } from "./audit-store.ts";
import { digest, type AuditJob, type AuditManifest, type AuditPage, type AuditSource } from "./audit-model.ts";
import {orderedAuditSources,privateAuditAttachment} from './audit-source-selection.ts';
export async function inspectPdf(bytes:Buffer):Promise<{pages:AuditPage[];limitations:string[]}> {
  const python=process.env.ORCHESTRATOR_AUDIT_PYTHON??process.env.ORCHESTRATOR_COO_PYTHON;
  if(!python||!path.isAbsolute(python))throw new Error("Audit PDF inspection is not configured.");
  const cached=await readPdfInspection(bytes);if(cached)return cached;
  const result=await new Promise<{pages:AuditPage[];limitations:string[]}>((resolve,reject)=>{
    const child=spawn(python,[path.join(process.cwd(),"scripts/audit-inspect-pdf.py")],{stdio:["pipe","pipe","pipe"],env:{NODE_ENV:process.env.NODE_ENV,PATH:process.env.PATH??"",...(process.env.ORCHESTRATOR_AUDIT_OCR?{ORCHESTRATOR_AUDIT_OCR:process.env.ORCHESTRATOR_AUDIT_OCR}:{}),PYTHONNOUSERSITE:"1",PYTHONIOENCODING:"utf-8"},signal:AbortSignal.timeout(720_000)});
    const chunks:Buffer[]=[];let size=0;child.on("error",()=>reject(new Error("PDF inspection failed or timed out.")));
    child.stdout.on("data",(b:Buffer)=>{size+=b.length;if(size>8_000_000){child.kill();reject(new Error("PDF extraction exceeds the pilot limit."));}else chunks.push(b);});
    child.stderr.on("data",()=>{});child.stdin.on("error",()=>{});
    child.on("close",code=>{try{if(code!==0)throw new Error();const data=JSON.parse(Buffer.concat(chunks).toString());if(!Array.isArray(data.pages)||!data.pages.length)throw new Error();resolve(data);}catch{reject(new Error("PDF inspection did not produce complete page metadata."));}});
    child.stdin.end(JSON.stringify({pdf:bytes.toString("base64")}));
  });
  await savePdfInspection(bytes,result).catch(()=>{});return result;
}
export async function inventoryAuditPdfs(folderId:string) {
  const drive=await ReadOnlyDrive.connect(),results:DriveItem[]=[],limitations:string[]=[];let folders=0;
  async function walk(id:string,depth:number){if(++folders>100){limitations.push('Folder inspection limit reached; some matter subfolders were not inspected.');return;}for(const item of await drive.children(id)){
    if(item.mimeType==="application/vnd.google-apps.folder"&&depth<4&&!/^(?:signing package (?:audit|review|qa)|audit reports?|review reports?)$/i.test(item.name))await walk(item.id,depth+1);
    else if(item.mimeType==="application/vnd.google-apps.folder"&&depth>=4)limitations.push("Folder depth limit reached; nested sources were not inspected.");
    else if(item.mimeType==="application/pdf"&&!privateAuditAttachment(item.name))results.push(item);
  }}await walk(folderId,0);const ordered=orderedAuditSources(results);if(ordered.length>256)limitations.push('PDF inventory limit reached; additional sources were not inspected.');return {items:ordered.slice(0,256),limitations:[...new Set(limitations)]};
}
export async function matterPdfs(folderId:string){return (await inventoryAuditPdfs(folderId)).items;}
type MailPart=AuditMailPart;
export async function captureAudit(job:AuditJob,inspect=inspectPdf):Promise<AuditManifest>{
  const sources:AuditSource[]=[],limitations:string[]=[];let budget=0;
  console.info(JSON.stringify({auditCapture:"started"}));
  async function pdf(id:string,name:string,kind:"package"|"support",bytes:Buffer){budget+=bytes.length;if(budget>200_000_000)throw new Error("Matter sources exceed the checked 200 MB capture limit. No complete audit can be published.");const hash=await putAuditBlob(bytes);console.info(JSON.stringify({auditCapture:"inspecting",kind}));const inspection=await inspect(bytes);console.info(JSON.stringify({auditCapture:"inspected",kind,pages:inspection.pages.length}));sources.push({id,name,kind,byteLength:bytes.length,sha256:hash,capturedAt:new Date().toISOString(),pages:inspection.pages});limitations.push(...inspection.limitations.map(l=>`${name}: ${l}`));if(job.lease)await renewAuditLease(job.id,job.lease);}
  await pdf(job.packageId,job.packageName,"package",await getAuditBlob(job.packageHash));
  sources[0].versionAt=job.cutoff;
  const drive=await ReadOnlyDrive.connect();const inventory=await inventoryAuditPdfs(job.folderId);limitations.push(...inventory.limitations);const items=inventory.items;
  for(const item of items){if(job.lease)await renewAuditLease(job.id,job.lease);if(item.id===job.packageId)continue;
    if(!item.modifiedTime||Date.parse(item.modifiedTime)>Date.parse(job.cutoff)){limitations.push(`${item.name}: historic version before the evidence cutoff was not established.`);continue;}
    if(Number(item.size)>20_000_000){limitations.push(`${item.name}: exceeds supporting source limit.`);continue;}
    try{const before=await drive.metadata(item.id),bytes=await drive.pdf(before),after=await drive.metadata(item.id);
    if(before.modifiedTime!==after.modifiedTime){limitations.push(`${item.name}: changed during capture and was excluded.`);continue;}
    if(sources.some(s=>s.sha256===digest(bytes)))continue;await pdf(item.id,item.name,"support",bytes);sources.at(-1)!.versionAt=before.modifiedTime;
    }catch{limitations.push(`${item.name}: supporting PDF could not be captured completely and was excluded.`);}
  }
  try {
    const mailbox=await AuditMailbox.connect();const query=auditMailQuery(job);
    const found:string[]=[];let pageToken:string|undefined;
    for(let page=0;page<10;page++){
      const matches=await mailbox.search(query,pageToken);
      found.push(...(matches.messages??[]).map((m:{threadId:string})=>m.threadId));
      pageToken=matches.nextPageToken;if(!pageToken)break;
    }
    if(pageToken)limitations.push("Mailbox collection exceeded 1,000 search matches; coverage is incomplete.");
    const allIds=[...new Set(found)],ids=allIds.slice(0,100);if(allIds.length>ids.length)limitations.push("Mailbox collection exceeded 100 threads; coverage is incomplete.");
    const seen=new Set<string>();let attachmentCount=0;
    async function attachments(part:MailPart,messageId:string,occurredAt:string){
      for(const child of part.parts??[])await attachments(child,messageId,occurredAt);
      if(!part.filename||part.mimeType!=="application/pdf"||!part.body?.attachmentId)return;
      if(privateAuditAttachment(part.filename)){limitations.push(`Email ${messageId}: identity/banking attachment excluded from automatic capture.`);return;}
      if(attachmentCount>=40){limitations.push("Email attachment collection exceeded 40 PDFs; coverage is incomplete.");return;}
      const result=await mailbox.attachment(messageId,part.body.attachmentId),bytes=Buffer.from(result.data??"","base64url");
      if(bytes.length>15_000_000||bytes.subarray(0,5).toString()!=="%PDF-"){limitations.push(`Email ${messageId}: attachment unreadable or oversized.`);return;}
      const id=`attachment-${messageId}-${digest(bytes).slice(0,16)}`;if(sources.some(s=>s.sha256===digest(bytes)))return;
      await pdf(id,part.filename,"support",bytes);sources.at(-1)!.occurredAt=occurredAt;attachmentCount++;
    }
    for(const id of ids){const thread=await mailbox.thread(id);
      const scoped=verifiedAddressThread((thread.messages??[]).filter((m:{internalDate:string})=>Number(m.internalDate)<Date.parse(job.cutoff)).map((m:{payload:MailPart})=>({subject:(m.payload.headers??[]).find(h=>h.name.toLowerCase()==='subject')?.value??'',contacts:(m.payload.headers??[]).filter(h=>/^(from|to|cc)$/i.test(h.name)).map(h=>h.value).join(' '),text:auditMailBody(m.payload)})),job);
      for(const m of thread.messages??[]){if(seen.has(m.id))continue;seen.add(m.id);
      const decision=selectHistoricalMailEvidence(m,{matterNumber:job.matterNumber,addressThreadVerified:scoped,cutoffExclusiveMs:Date.parse(job.cutoff)});if(!decision.eligible)continue;
      const content=auditMailEvidenceText(m.payload);if(!content.hasBody)continue;
      if(content.truncated)limitations.push(`Email ${m.id}: body exceeded 64,000 characters; quoted history may be incomplete.`);
      const bytes=Buffer.from(content.text),hash=await putAuditBlob(bytes);sources.push({id:`mail-${m.id}`,name:"Matter correspondence",kind:"email",sha256:hash,capturedAt:new Date().toISOString(),occurredAt:new Date(Number(m.internalDate)).toISOString(),pages:[{number:1,text:content.text,rendered:false,inkRatio:null}]});
      await attachments(m.payload,m.id,new Date(Number(m.internalDate)).toISOString());
    }}
    if(!sources.some(s=>s.kind==='email'))limitations.push("No live email messages were captured. Current extensions, deposits and correspondence follow-ups may be missing; review mailbox coverage before relying on this report.");
    limitations.push("Email scope: file-number variants and property-address searches; address matches require client corroboration and reject competing file numbers. Derived reports, bulk mail, unverified address matches and excluded attachments are not evidence.");
  }catch{limitations.push("Mailbox capture unavailable. Missing correspondence is not proof of non-delivery or non-completion.");}
  return {matterId:job.matterId,matterNumber:job.matterNumber,packageHash:job.packageHash,cutoff:job.cutoff,ruleset:job.ruleset,sources,limitations:[...new Set(limitations)]};
}
