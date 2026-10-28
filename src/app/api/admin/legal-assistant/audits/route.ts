import {assertHostedWorker} from "@/lib/orchestrator/hosted/runtime";
import {NextRequest,NextResponse} from "next/server";
import {getStaff} from "@/lib/orchestrator/server-auth";
import {getSnapshot} from "@/lib/orchestrator/store";
import {enqueueAudit,putAuditBlob,updateAuditDisposition} from "@/lib/orchestrator/audit-store";
import {auditReadiness} from "@/lib/orchestrator/audit-openai";
import {matterPdfs} from "@/lib/orchestrator/audit-capture";
import {ReadOnlyDrive} from "@/lib/orchestrator/google-drive";
import {AUDIT_RULESET,type Disposition} from "@/lib/orchestrator/audit-model";
import {auditViewSnapshot} from "@/lib/orchestrator/audit-view";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const json=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{"Cache-Control":"no-store"}});
async function context(fileId:string|null){const user=await getStaff();if(!user)return null;const matter=(await getSnapshot()).matters.find(m=>m.id===fileId);return matter?{user,matter}:null;}
export async function GET(request:NextRequest){try{
  const ctx=await context(request.nextUrl.searchParams.get("fileId"));if(!ctx)return json({error:"Staff access and a valid file are required."},404);
  const snapshot=await auditViewSnapshot(ctx.matter.id);
  const sources=request.nextUrl.searchParams.get("sources")==="true"&&ctx.matter.driveFolderId?(await matterPdfs(ctx.matter.driveFolderId)).map(f=>({id:f.id,name:f.name,size:f.size,modifiedTime:f.modifiedTime})):undefined;
  return json({...snapshot,sources});
}catch{return json({error:"The audit register could not be read."},503);}}
export async function POST(request:NextRequest){try{
  const origin=process.env.ORCHESTRATOR_APP_URL??"http://127.0.0.1:3002";if(request.headers.get("origin")!==origin)return json({error:"Invalid request origin."},403);
  const raw=await request.text();if(raw.length>8000)return json({error:"Request too large."},413);const input=JSON.parse(raw);
  const ctx=await context(input.fileId);if(!ctx)return json({error:"Staff access and a valid file are required."},404);
  if(input.action==="feedback"){const report=await updateAuditDisposition(ctx.matter.id,input.findingId,input.expectedRevision,input.disposition as Disposition,input.notes,ctx.user.id);return json({report});}
  await assertHostedWorker("audits");
  const readiness=auditReadiness();if(!readiness.enabled)return json({error:"Real-file audits are not enabled yet.",readiness},409);
  if(!ctx.matter.driveFolderId)return json({error:"Link a verified matter folder first."},409);
  const choices=await matterPdfs(ctx.matter.driveFolderId),selected=choices.find(f=>f.id===input.packageId);if(!selected)return json({error:"Choose a PDF from the linked matter folder."},400);
  const drive=await ReadOnlyDrive.connect(),before=await drive.metadata(selected.id),bytes=await drive.pdf(before),after=await drive.metadata(selected.id);
  if(before.modifiedTime!==after.modifiedTime)return json({error:"Package changed during capture. Refresh and select it again."},409);
  const packageHash=await putAuditBlob(bytes);
  const result=await enqueueAudit({matterId:ctx.matter.id,matterNumber:ctx.matter.number,folderId:ctx.matter.driveFolderId,packageId:selected.id,packageName:selected.name,packageHash,ruleset:AUDIT_RULESET,actor:ctx.user.id,requestId:input.requestId,rerunOf:input.rerunOf});
  return json({job:result.job,duplicate:result.duplicate},result.duplicate?200:202);
}catch{return json({error:"Submission or feedback could not be saved. Refresh the report; retry the same request if its outcome is unknown."},409);}}
