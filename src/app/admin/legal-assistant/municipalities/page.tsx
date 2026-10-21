import {redirect} from "next/navigation";
import {getStaff} from "@/lib/orchestrator/server-auth";
import {workflowSettings} from "@/lib/orchestrator/workflow-settings";
import MunicipalityDirectory from "@/components/coo/MunicipalityDirectory";
export const dynamic='force-dynamic';
export default async function Municipalities(){if(!await getStaff())redirect('/admin/login');const s=await workflowSettings();return <MunicipalityDirectory initialEntries={s.municipalities} initialRevision={s.revision}/>;}
