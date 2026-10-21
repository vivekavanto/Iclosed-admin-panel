import {redirect,notFound} from "next/navigation";
import {getStaff} from "@/lib/orchestrator/server-auth";
import {getSnapshot} from "@/lib/orchestrator/store";
import AuditWorkspace from "@/components/orchestrator/AuditWorkspace";
export const dynamic="force-dynamic";
export default async function AuditPage({params}:{params:Promise<{fileId:string}>}){const user=await getStaff();if(!user)redirect('/admin/login');const {fileId}=await params;let decoded:string;try{decoded=decodeURIComponent(fileId);}catch{notFound();}const matter=(await getSnapshot()).matters.find(m=>m.id===fileId||m.id===decoded);if(!matter)notFound();return <AuditWorkspace matter={matter}/>;}
