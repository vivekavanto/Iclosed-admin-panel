import {hostedDocumentsEnabled} from "./hosted/document.ts";
import {hostedWorkerHealth} from "./hosted/runtime.ts";
import {auditSnapshot,auditProviderStatus} from "./audit-store.ts";
import {auditReadiness} from "./audit-openai.ts";
import {workflowSettings} from "./workflow-settings.ts";
import {auditCoverageSummary} from "./audit-coverage.ts";

/** Local report state only: displaying saved findings never waits for Drive inventory. */
export async function auditViewSnapshot(fileId:string){
 const [snapshot,settings,providerStatus]=await Promise.all([auditSnapshot(fileId),workflowSettings(),auditProviderStatus()]);
 const readiness=auditReadiness();if(hostedDocumentsEnabled()&&!(await hostedWorkerHealth("audits")).ready){readiness.enabled=false;readiness.reasons.push("The hosted audit worker is unavailable.");}
 return {...snapshot,providerStatus,overallComments:settings.comments.filter(c=>c.fileId===fileId),jobs:snapshot.jobs.map(({manifest,...job})=>({...job,coverage:[...(manifest?.limitations??[]),...(job.coverageScope==="consolidated"?job.reviewerCoverage??[]:(job.reviewerCoverage??[]).filter(line=>/visual PDF budget exceeded|per-pass visual page budget exceeded/.test(line)))],sourceCount:manifest?.sources.length,sourceSummary:auditCoverageSummary(manifest)})),readiness};
}
