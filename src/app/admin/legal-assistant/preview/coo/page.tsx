import { notFound } from "next/navigation";
import CooWorkspace from "@/components/coo/CooWorkspace";
import { cooDemoDraft } from "@/lib/coo/demo";
export default async function CooPreviewPage({searchParams}:{searchParams:Promise<{type?:string}>}){
 if(process.env.NODE_ENV!=="development"||process.env.ORCHESTRATOR_PREVIEW!=="true")notFound();
 const query=await searchParams;const draft=structuredClone(cooDemoDraft);
 draft.recipients.condo.enabled=false;draft.completeTransferConfirmed=true;draft.differentDatesConfirmed=true;
 if(query.type==="sale"){draft.transaction="sale";draft.fileId="demo:26S-0902";draft.fileNumber="26S-0902";draft.newOwners="Casey Lee\nRiley Lee";}
 if(query.type==="refinance"){draft.transaction="refinance";draft.fileId="demo:26R-0903";draft.fileNumber="26R-0903";draft.ownershipTransfer=false;draft.newOwners="Casey Lee\nRiley Lee";}
 return <CooWorkspace initialDraft={draft} demo/>;
}
