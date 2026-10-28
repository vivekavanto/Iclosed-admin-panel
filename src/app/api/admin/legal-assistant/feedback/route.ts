import {NextRequest,NextResponse} from "next/server";
import {getStaff} from "@/lib/orchestrator/server-auth";
import {getSnapshot} from "@/lib/orchestrator/store";
import {canManageOrchestrator} from "@/lib/orchestrator/permissions";
import {addReportComment,reviewReportComment} from "@/lib/orchestrator/workflow-settings";
export const dynamic="force-dynamic";
const json=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:NextRequest){
 const user=await getStaff();if(!user)return json({error:"Staff sign-in required."},401);
 if(request.headers.get('origin')!==request.nextUrl.origin)return json({error:"Invalid origin."},403);
 try{const raw=await request.text();if(raw.length>16000)return json({error:"Request too large."},413);const input=JSON.parse(raw);
 if(input.action==='review'){if(!canManageOrchestrator(user))return json({error:"Manager access required for feedback approval."},403);return json({comment:await reviewReportComment(input.id,input.status,input.expectedStatus,input.note??'',user.id,user.email??'')});}
 if(input.action!=='add')return json({error:"Unknown action."},400);
 if(typeof input.fileId!=='string')return json({error:"Choose a file or General feedback."},400);
 if(input.fileId&&!(await getSnapshot()).matters.some(m=>m.id===input.fileId))return json({error:"File not found."},404);
 return json({comment:await addReportComment(input.fileId,null,input.comment,user.id,user.email??'')},201);
 }catch(e){return json({error:e instanceof Error?e.message:"Feedback could not be saved."},409);}
}
