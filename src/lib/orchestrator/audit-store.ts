import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localStateDirectory } from "./local-store.ts";
import { digest, reconcileAudit, type AuditJob, type AuditManifest, type AuditReport, type Disposition, type ReviewResult } from "./audit-model.ts";
interface State { jobs: AuditJob[]; reports: Record<string,AuditReport>; requests: Record<string,{signature:string;jobId:string}>; }
export function auditDirectory() { const root = localStateDirectory(); if (!root) throw new Error("Persistent shadow audit storage is not configured. Production submissions remain disabled."); return path.join(root,"audits"); }
async function read(): Promise<State> { try { return JSON.parse(await readFile(path.join(auditDirectory(),"jobs.json"),"utf8")); } catch(e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return {jobs:[],reports:{},requests:{}}; } }
async function transaction<T>(fn:(state:State)=>T) {
  const root=auditDirectory();await mkdir(root,{recursive:true,mode:0o700});const lock=path.join(root,".lock");let acquired=false;
  for(let i=0;i<50;i++){try{await mkdir(lock,{mode:0o700});acquired=true;break;}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;await new Promise(r=>setTimeout(r,20));}}
  if(!acquired)throw new Error("Audit storage is busy. Retry the same request; do not submit a new one.");
  const tmp=path.join(root,`.${randomUUID()}.tmp`);
  try { const state=await read(),result=fn(state);await writeFile(tmp,JSON.stringify(state),{mode:0o600});await rename(tmp,path.join(root,"jobs.json"));return result; }
  finally{await rm(tmp,{force:true});await rm(lock,{recursive:true,force:true});}
}
export async function putAuditBlob(bytes:Buffer) { const hash=digest(bytes),root=path.join(auditDirectory(),"blobs");await mkdir(root,{recursive:true,mode:0o700});try{await writeFile(path.join(root,hash),bytes,{flag:"wx",mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;const prior=await readFile(path.join(root,hash));if(digest(prior)!==hash)throw new Error("Source integrity check failed.");}return hash; }
export async function getAuditBlob(hash:string) {if(!/^[a-f0-9]{64}$/.test(hash))throw new Error("Invalid source hash.");const bytes=await readFile(path.join(auditDirectory(),"blobs",hash));if(digest(bytes)!==hash)throw new Error("Frozen audit source changed.");return bytes;}
export async function enqueueAudit(input: Pick<AuditJob,"matterId"|"matterNumber"|"packageId"|"packageHash"|"packageName"|"folderId"|"ruleset"|"actor"> & {requestId:string;rerunOf?:string}) {
  if(!/^[a-f0-9-]{36}$/i.test(input.requestId))throw new Error("A unique submission request ID is required.");
  const signature=digest(JSON.stringify([input.matterId,input.packageHash,input.ruleset,input.rerunOf??null]));
  return transaction(state=>{
    const prior=state.requests[input.requestId];if(prior){if(prior.signature!==signature)throw new Error("This request ID belongs to a different submission.");return {job:state.jobs.find(j=>j.id===prior.jobId)!,duplicate:true};}
    const jobs=state.jobs.filter(j=>j.matterId===input.matterId),latest=jobs.at(-1);
    // An expired worker is not silently resumed or published; manual retry is required.
    for(const j of jobs)if(["capturing","reviewing"].includes(j.status)&&Date.parse(j.leaseUntil??"")<Date.now()){j.status="failed";j.error="Worker stopped before completion. Review sources and request a manual rerun.";j.updatedAt=new Date().toISOString();}
    const active=jobs.find(j=>["queued","capturing","reviewing"].includes(j.status));
    if(active){state.requests[input.requestId]={signature,jobId:active.id};return {job:active,duplicate:true};}
    if(input.rerunOf){if(!latest||latest.id!==input.rerunOf)throw new Error("Audit history changed. Refresh before confirming this rerun.");}
    else {const same=jobs.findLast(j=>j.packageHash===input.packageHash&&j.ruleset===input.ruleset);if(same){state.requests[input.requestId]={signature,jobId:same.id};return {job:same,duplicate:true};}}
    const now=new Date().toISOString(),job:AuditJob={...input,id:randomUUID(),cutoff:now,createdAt:now,updatedAt:now,status:"queued"};
    state.jobs.push(job);state.requests[input.requestId]={signature,jobId:job.id};return {job,duplicate:false};
  });
}
function visibleJob(j:AuditJob):AuditJob {const expired=["capturing","reviewing"].includes(j.status)&&Date.parse(j.leaseUntil??"")<=Date.now();return {...j,lease:undefined,...(expired?{status:"failed" as const,error:"Worker lease expired. Existing report retained; request a manual rerun."}:{})};}
export async function auditSnapshot(matterId:string){const s=await read();return {jobs:s.jobs.filter(j=>j.matterId===matterId).map(visibleJob),report:s.reports[matterId]??null};}
export async function auditDashboardSummaries(){const s=await read();return Object.fromEntries([...new Set(s.jobs.map(j=>j.matterId))].map(id=>[id,{report:!!s.reports[id],status:visibleJob(s.jobs.filter(j=>j.matterId===id).at(-1)!).status}]));}
export async function claimAudit() {return transaction(s=>{const job=s.jobs.find(j=>j.status==="queued");if(!job)return null;job.status="capturing";job.lease=randomUUID();job.leaseUntil=new Date(Date.now()+15*60_000).toISOString();job.updatedAt=new Date().toISOString();return job;});}
export async function checkpointAudit(id:string,lease:string,manifest:AuditManifest){return transaction(s=>{const job=s.jobs.find(j=>j.id===id);assertLease(job,lease);if(manifest.matterId!==job!.matterId||manifest.packageHash!==job!.packageHash||manifest.cutoff!==job!.cutoff||manifest.ruleset!==job!.ruleset||!manifest.sources.some(source=>source.kind==="package"&&source.sha256===job!.packageHash))throw new Error("Manifest does not match the frozen job.");job!.manifest=manifest;job!.status="reviewing";job!.updatedAt=new Date().toISOString();});}
function assertLease(job:AuditJob|undefined,lease:string){if(!job||job.lease!==lease||!['capturing','reviewing'].includes(job.status)||Date.parse(job.leaseUntil??'')<=Date.now())throw new Error("Audit lease expired; publication refused.");}
export async function renewAuditLease(id:string,lease:string){return transaction(s=>{const job=s.jobs.find(j=>j.id===id);assertLease(job,lease);job!.leaseUntil=new Date(Date.now()+15*60_000).toISOString();job!.updatedAt=new Date().toISOString();});}
export async function finishAudit(id:string,lease:string,review:ReviewResult) {return transaction(s=>{const job=s.jobs.find(j=>j.id===id);assertLease(job,lease);if(!job!.manifest)throw new Error("Frozen source manifest is required.");const report=reconcileAudit(s.reports[job!.matterId],job!,job!.manifest,review,Object.fromEntries(s.jobs.filter(j=>j.matterId===job!.matterId&&j.manifest).map(j=>[j.id,j.manifest!])));s.reports[job!.matterId]=report;job!.reviewerCoverage=review.coverage;job!.status="completed";job!.updatedAt=new Date().toISOString();delete job!.lease;return report;});}
export async function failAudit(id:string,lease:string){return transaction(s=>{const job=s.jobs.find(j=>j.id===id);assertLease(job,lease);job!.status="failed";job!.error="Audit did not complete. Existing reports and notes were retained; use manual rerun after checking the connection.";job!.updatedAt=new Date().toISOString();delete job!.lease;});}
export async function updateAuditDisposition(matterId:string,findingId:string,expectedRevision:number,disposition:Disposition,notes:string,actor="local-test"){return transaction(s=>{const report=s.reports[matterId];if(!report||report.revision!==expectedRevision)throw new Error("Report changed. Refresh before saving notes.");if(!["Open","Implemented","Incorrectly flagged","Needs lawyer review"].includes(disposition)||typeof notes!=="string"||notes.length>4000)throw new Error("Invalid clerk feedback.");const f=report.findings.find(f=>f.id===findingId);if(!f)throw new Error("Finding not found.");f.disposition=disposition;f.notes=notes;(report.feedbackHistory??=[]).push({at:new Date().toISOString(),actor,findingId,disposition,notes});report.revision++;return report;});}
