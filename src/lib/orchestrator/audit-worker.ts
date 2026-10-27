import { captureAudit } from "./audit-capture.ts";
import { claimAudit, checkpointAudit, failAudit, finishAudit,recordAuditReviewProgress } from "./audit-store.ts";
import type { AuditManifest, ReviewResult,AuditReviewProgress } from "./audit-model.ts";
import {safeAuditFailure,type AuditStage} from './audit-failure.ts';
export interface AuditReviewer { review(manifest:AuditManifest,onProgress?:(progress:AuditReviewProgress)=>Promise<void>):Promise<ReviewResult>; }
/** Separate worker process; HTTP submission only queues work. No in-request fire-and-forget. */
export async function runAuditWorker(reviewer:AuditReviewer, capture=captureAudit) {
  const job=await claimAudit();if(!job)return {processed:false};
  let stage:AuditStage='capture';
  try{const manifest=await capture(job);await checkpointAudit(job.id,job.lease!,manifest);stage='review';const review=await reviewer.review(manifest,progress=>recordAuditReviewProgress(job.id,job.lease!,progress));stage='publish';const report=await finishAudit(job.id,job.lease!,review);return {processed:true,status:"completed",jobId:job.id,reportRevision:report.revision};}
  catch(error){const failure=safeAuditFailure(error,stage);await failAudit(job.id,job.lease!,failure).catch(()=>{});return {processed:true,status:"failed",jobId:job.id,failure};}
}
