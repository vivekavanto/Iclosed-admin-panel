import { captureAudit } from "./audit-capture.ts";
import { claimAudit, checkpointAudit, failAudit, finishAudit } from "./audit-store.ts";
import type { AuditManifest, ReviewResult } from "./audit-model.ts";
export interface AuditReviewer { review(manifest:AuditManifest):Promise<ReviewResult>; }
/** Separate worker process; HTTP submission only queues work. No in-request fire-and-forget. */
export async function runAuditWorker(reviewer:AuditReviewer, capture=captureAudit) {
  const job=await claimAudit();if(!job)return {processed:false};
  try{const manifest=await capture(job);await checkpointAudit(job.id,job.lease!,manifest);const review=await reviewer.review(manifest);const report=await finishAudit(job.id,job.lease!,review);return {processed:true,status:"completed",jobId:job.id,reportRevision:report.revision};}
  catch{await failAudit(job.id,job.lease!).catch(()=>{});return {processed:true,status:"failed",jobId:job.id};}
}
