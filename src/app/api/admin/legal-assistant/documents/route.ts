import { NextRequest, NextResponse } from "next/server";
import { getStaff } from "@/lib/orchestrator/server-auth";
import { getSnapshot } from "@/lib/orchestrator/store";
import { ReadOnlyDrive } from "@/lib/orchestrator/google-drive";

export async function GET(request: NextRequest) {
  const user = await getStaff();
  if(!user) return NextResponse.json({error:"Staff sign-in required."},{status:401});
  try {
    const id=request.nextUrl.searchParams.get("fileId");
    const snapshot=await getSnapshot();
    const matter=snapshot.matters.find(m=>m.id===id);
    if(!matter?.driveFolderId) return NextResponse.json({error:"A verified folder has not been linked."},{status:404});
    const drive=await ReadOnlyDrive.connect();
    const files=await drive.children(matter.driveFolderId);
    return NextResponse.json({files:files.map(file=>({id:file.id,name:file.name,type:file.mimeType,modifiedTime:file.modifiedTime,url:file.mimeType==="application/vnd.google-apps.folder"?`https://drive.google.com/drive/folders/${file.id}`:`https://drive.google.com/file/d/${file.id}/view`}))});
  } catch(error) {return NextResponse.json({error:error instanceof Error?error.message:"Unable to read file documents."},{status:409});}
}
