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
  async function walk(id:string,depth:number){if(++folders>20){limitations.push('Folder inspection limit reached; some matter subfolders were not inspected.');return;}for(const item of await drive.children(id)){
    if(item.mimeType==="application/vnd.google-apps.folder"&&depth<2&&!/^(?:signing package (?:audit|review|qa)|audit reports?|review reports?)$/i.test(item.name))await walk(item.id,depth+1);
    else if(item.mimeType==="application/pdf"&&!privateAuditAttachment(item.name))results.push(item);
  }}await walk(folderId,0);const ordered=orderedAuditSources(results);if(ordered.length>80)limitations.push('PDF inventory limit reached; additional sources were not inspected.');return {items:ordered.slice(0,80),limitations:[...new Set(limitations)]};
}
export async function matterPdfs(folderId:string){return (await inventoryAuditPdfs(folderId)).items;}
interface MailPart {mimeType?:string;filename?:string;body?:{data?:string;attachmentId?:string};parts?:MailPart[];headers?:{name:string;value:string}[];}
function mailText(p:MailPart):string {if(p.mimeType==="text/plain"&&p.body?.data)return Buffer.from(p.body.data,"base64url").toString("utf8");return (p.parts??[]).map(mailText).join("\n");}
export async function captureAudit(job:AuditJob,inspect=inspectPdf):Promise<AuditManifest>{
  const sources:AuditSource[]=[],limitations:string[]=[];let budget=0;
  console.info(JSON.stringify({auditCapture:"started"}));
  async function pdf(id:string,name:string,kind:"package"|"support",bytes:Buffer){budget+=bytes.length;if(budget>100_000_000)throw new Error("Matter sources exceed the audit limit.");const hash=await putAuditBlob(bytes);console.info(JSON.stringify({auditCapture:"inspecting",kind}));const inspection=await inspect(bytes);console.info(JSON.stringify({auditCapture:"inspected",kind,pages:inspection.pages.length}));sources.push({id,name,kind,sha256:hash,capturedAt:new Date().toISOString(),pages:inspection.pages});limitations.push(...inspection.limitations.map(l=>`${name}: ${l}`));if(job.lease)await renewAuditLease(job.id,job.lease);}
  await pdf(job.packageId,job.packageName,"package",await getAuditBlob(job.packageHash));
  sources[0].versionAt=job.cutoff;
  const drive=await ReadOnlyDrive.connect();const inventory=await inventoryAuditPdfs(job.folderId);limitations.push(...inventory.limitations);const items=inventory.items;let used=0;
  for(const item of items){if(item.id===job.packageId)continue;if(used>=24){limitations.push("Supporting document pilot limit reached (24 PDFs); some sources were not reviewed.");break;}
    if(!item.modifiedTime||Date.parse(item.modifiedTime)>Date.parse(job.cutoff)){limitations.push(`${item.name}: historic version before the evidence cutoff was not established.`);continue;}
    if(Number(item.size)>20_000_000){limitations.push(`${item.name}: exceeds supporting source limit.`);continue;}
    try{const before=await drive.metadata(item.id),bytes=await drive.pdf(before),after=await drive.metadata(item.id);
    if(before.modifiedTime!==after.modifiedTime){limitations.push(`${item.name}: changed during capture and was excluded.`);continue;}
    if(sources.some(s=>s.sha256===digest(bytes)))continue;await pdf(item.id,item.name,"support",bytes);sources.at(-1)!.versionAt=before.modifiedTime;used++;
    }catch{limitations.push(`${item.name}: supporting PDF could not be captured completely and was excluded.`);}
  }
  try {
    const mailbox=await AuditMailbox.connect();const query=`"${job.matterNumber.replace(/[^a-zA-Z0-9-]/g,"")}" before:${Math.ceil(Date.parse(job.cutoff)/1000)}`;
    const matches=await mailbox.search(query);if(matches.nextPageToken)limitations.push("Mailbox pilot search limit reached; coverage is incomplete.");
    const ids=[...new Set<string>((matches.messages??[]).map((m:{threadId:string})=>m.threadId))].slice(0,20);const seen=new Set<string>();let attachmentCount=0;
    async function attachments(part:MailPart,messageId:string,occurredAt:string){
      for(const child of part.parts??[])await attachments(child,messageId,occurredAt);
      if(!part.filename||part.mimeType!=="application/pdf"||!part.body?.attachmentId)return;
      if(privateAuditAttachment(part.filename)){limitations.push(`Email ${messageId}: identity/banking attachment excluded from automatic capture.`);return;}
      if(attachmentCount>=8){limitations.push("Email attachment pilot limit reached; coverage is incomplete.");return;}
      const result=await mailbox.attachment(messageId,part.body.attachmentId),bytes=Buffer.from(result.data??"","base64url");
      if(bytes.length>15_000_000||bytes.subarray(0,5).toString()!=="%PDF-"){limitations.push(`Email ${messageId}: attachment unreadable or oversized.`);return;}
      const id=`attachment-${messageId}-${digest(bytes).slice(0,16)}`;if(sources.some(s=>s.sha256===digest(bytes)))return;
      await pdf(id,part.filename,"support",bytes);sources.at(-1)!.occurredAt=occurredAt;attachmentCount++;
    }
    for(const id of ids){const thread=await mailbox.thread(id);for(const m of thread.messages??[]){if(seen.has(m.id))continue;seen.add(m.id);
      const decision=selectHistoricalMailEvidence(m,{matterNumber:job.matterNumber,cutoffExclusiveMs:Date.parse(job.cutoff)});if(!decision.eligible)continue;
      const body=mailText(m.payload).split(/\nOn .{0,300}wrote:|\nFrom:/)[0].split("\n").filter(l=>!l.trimStart().startsWith(">")).join("\n").slice(0,15000);
      if(!body.trim())continue;const bytes=Buffer.from(body),hash=await putAuditBlob(bytes);sources.push({id:`mail-${m.id}`,name:"Matter correspondence",kind:"email",sha256:hash,capturedAt:new Date().toISOString(),occurredAt:new Date(Number(m.internalDate)).toISOString(),pages:[{number:1,text:body,rendered:false,inkRatio:null}]});
      await attachments(m.payload,m.id,new Date(Number(m.internalDate)).toISOString());
    }}
    limitations.push("Email scope: exact file-number search and verified subjects only; address-only correspondence, excluded digests, portals and skipped attachments may contain additional evidence.");
  }catch{limitations.push("Mailbox capture unavailable. Missing correspondence is not proof of non-delivery or non-completion.");}
  return {matterId:job.matterId,matterNumber:job.matterNumber,packageHash:job.packageHash,cutoff:job.cutoff,ruleset:job.ruleset,sources,limitations:[...new Set(limitations)]};
}
