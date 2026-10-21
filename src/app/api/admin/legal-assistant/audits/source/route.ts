import {NextRequest,NextResponse} from "next/server";
import {getStaff} from "@/lib/orchestrator/server-auth";
import {getSnapshot} from "@/lib/orchestrator/store";
import {auditSnapshot,getAuditBlob} from "@/lib/orchestrator/audit-store";
export const runtime="nodejs";
export async function GET(request:NextRequest){
  if(!await getStaff())return NextResponse.json({error:"Staff sign-in required."},{status:401});
  try{const matterId=request.nextUrl.searchParams.get("fileId"),jobId=request.nextUrl.searchParams.get("jobId"),sourceId=request.nextUrl.searchParams.get("sourceId");
    if(!(await getSnapshot()).matters.some(m=>m.id===matterId))throw new Error();
    const job=(await auditSnapshot(matterId!)).jobs.find(j=>j.id===jobId),source=job?.manifest?.sources.find(s=>s.id===sourceId);if(!source)throw new Error();
    const bytes=await getAuditBlob(source.sha256),pdf=source.kind!=="email";return new Response(new Uint8Array(bytes),{headers:{"Content-Type":pdf?"application/pdf":"text/plain; charset=utf-8","Content-Disposition":`inline; filename="audit-source.${pdf?"pdf":"txt"}"`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  }catch{return NextResponse.json({error:"Frozen source not available for this file."},{status:404});}
}
