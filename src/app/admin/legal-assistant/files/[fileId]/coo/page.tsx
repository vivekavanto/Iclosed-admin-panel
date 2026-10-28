import {workflowResult} from "@/lib/orchestrator/hosted/payload";
import { notFound,redirect } from "next/navigation";
import CooWorkspace from "@/components/coo/CooWorkspace";
import { getStaff } from "@/lib/orchestrator/server-auth";
import { getSnapshot } from "@/lib/orchestrator/store";
import { initialCooDraft } from "@/lib/coo/prepare";
import {workflowSettings,resolveMunicipality} from "@/lib/orchestrator/workflow-settings";
import {cooDriveDocuments} from "@/lib/coo/drive-documents";
import {latestCooReview} from "@/lib/coo/delivery-store";
import {cooSendReadiness} from "@/lib/coo/send";
export const dynamic="force-dynamic";
export default async function CooFilePage({params}:{params:Promise<{fileId:string}>}){
 if(!await getStaff())redirect("/admin/login");const{fileId}=await params;const snapshot=await getSnapshot();const m=snapshot.matters.find(x=>x.id===fileId||x.id===decodeURIComponent(fileId));if(!m)notFound();
 const settings=await workflowSettings();const draft=initialCooDraft(m,resolveMunicipality(m.address,settings.municipalities));
 const drive=await cooDriveDocuments(m.driveFolderId).catch(()=>({documents:[],message:'The linked Drive folder could not be read. Existing notices have not been assessed.'}));
 const savedReview=await latestCooReview(m.id);
 const payload=savedReview?await workflowResult(savedReview):null;
 const privateUrl=payload&&typeof payload==='object'&&'privateResultUrl' in payload?String(payload.privateResultUrl):undefined;
 return <CooWorkspace savedReview={privateUrl?undefined:savedReview??undefined} savedReviewUrl={privateUrl} sendEnabled={cooSendReadiness().enabled} initialDraft={savedReview?.draft??draft} driveDocuments={drive.documents} driveMessage={drive.message} driveFolderId={m.driveFolderId} fileStatus={m.status}/>;
}
