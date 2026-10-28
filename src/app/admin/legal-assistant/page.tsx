import { redirect } from "next/navigation";
import Orchestrator from "@/components/orchestrator/Orchestrator";
import { getStaff } from "@/lib/orchestrator/server-auth";
import { getSnapshot } from "@/lib/orchestrator/store";
import { canManageOrchestrator } from "@/lib/orchestrator/permissions";

import {auditDashboardSummaries} from "@/lib/orchestrator/audit-store";

import {workflowSettings} from "@/lib/orchestrator/workflow-settings";
import { torontoDate } from "@/lib/orchestrator/closing-views";
import {cooDashboardSummaries} from "@/lib/coo/delivery-store";
export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  const user = await getStaff();
  if (!user) redirect("/admin/login");
  let snapshot;
  let error: string | undefined;
  try {
    snapshot = await getSnapshot();
  } catch {
    error = "The file register is not connected yet. Existing data has not been changed.";
  }
  const workflow=await workflowSettings().catch(()=>null);
  const auditSummaries=await auditDashboardSummaries().catch(()=>({}));
  const cooSummaries=await cooDashboardSummaries();
  return <Orchestrator cooSummaries={cooSummaries} initialToday={torontoDate()} auditSummaries={auditSummaries} initialMatters={(snapshot?.matters ?? []).map(m=>({...m,mortgageInstructions:workflow?.mortgage[m.id],mortgageClientsInformed:workflow?.mortgageClientsInformed?.[m.id]}))} initialRevision={snapshot?.revision} initialImportDate={snapshot?.sourceDate} initialCoverageEnd={snapshot?.coverageEnd} email={user.email} manage={canManageOrchestrator(user)} initialError={error} />;
}
