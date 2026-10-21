import { notFound,redirect } from "next/navigation";
import CooWorkspace from "@/components/coo/CooWorkspace";
import { getStaff } from "@/lib/orchestrator/server-auth";
import { getSnapshot } from "@/lib/orchestrator/store";
import { initialCooDraft } from "@/lib/coo/prepare";
import {workflowSettings,resolveMunicipality} from "@/lib/orchestrator/workflow-settings";
export const dynamic="force-dynamic";
export default async function CooFilePage({params}:{params:Promise<{fileId:string}>}){
 if(!await getStaff())redirect("/admin/login");const{fileId}=await params;const snapshot=await getSnapshot();const m=snapshot.matters.find(x=>x.id===fileId||x.id===decodeURIComponent(fileId));if(!m)notFound();
 const settings=await workflowSettings();const draft=initialCooDraft(m,resolveMunicipality(m.address,settings.municipalities));
 return <CooWorkspace initialDraft={draft}/>;
}
