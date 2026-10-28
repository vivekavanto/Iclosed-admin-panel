import TeamIntegrationStatus from "@/components/orchestrator/TeamIntegrationStatus";
import {redirect} from "next/navigation";
import Orchestrator from "@/components/orchestrator/Orchestrator";
import {getStaff} from "@/lib/orchestrator/server-auth";
import {getSnapshot} from "@/lib/orchestrator/store";
import {canManageOrchestrator} from "@/lib/orchestrator/permissions";
import {torontoDate} from "@/lib/orchestrator/closing-views";
export const dynamic="force-dynamic";
export default async function SettingsPage(){
 const user=await getStaff();if(!user)redirect("/admin/login");
 let snapshot;let error:string|undefined;
 try{snapshot=await getSnapshot();}catch{error="The file register is not connected yet. Existing data has not been changed.";}
 return <><Orchestrator settingsOnly initialToday={torontoDate()} initialMatters={snapshot?.matters??[]} initialRevision={snapshot?.revision} initialImportDate={snapshot?.sourceDate} initialCoverageEnd={snapshot?.coverageEnd} email={user.email} manage={canManageOrchestrator(user)} initialError={error}/><TeamIntegrationStatus/></>;
}
