import {redirect} from "next/navigation";
import {getStaff} from "@/lib/orchestrator/server-auth";
import {getSnapshot} from "@/lib/orchestrator/store";
import {workflowSettings} from "@/lib/orchestrator/workflow-settings";
import {canManageOrchestrator} from "@/lib/orchestrator/permissions";
import FeedbackBoard from "@/components/orchestrator/FeedbackBoard";
export const dynamic="force-dynamic";
export default async function FeedbackPage(){const user=await getStaff();if(!user)redirect('/admin/login');const [workflow,snapshot]=await Promise.all([workflowSettings(),getSnapshot()]);return <FeedbackBoard initial={workflow.comments} canReview={canManageOrchestrator(user)} files={snapshot.matters.map(m=>({id:m.id,number:m.number,address:m.address}))}/>;}
