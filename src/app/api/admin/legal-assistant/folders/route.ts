import { NextRequest, NextResponse } from "next/server";
import { getStaff } from "@/lib/orchestrator/server-auth";
import { canManageOrchestrator } from "@/lib/orchestrator/permissions";
import { getSnapshot, linkVerifiedFolder } from "@/lib/orchestrator/store";
import { inClosingView, torontoDate } from "@/lib/orchestrator/closing-views";
import { discoverMatterFolders } from "@/lib/orchestrator/folder-discovery";

export async function POST(request: NextRequest) {
  const user = await getStaff();
  if (!user || !canManageOrchestrator(user)) return NextResponse.json({error:"Administrator access required."},{status:403});
  if(request.headers.get("origin") !== request.nextUrl.origin) return NextResponse.json({error:"Invalid origin."},{status:403});
  try {
    const body = await request.json();
    if (body.afterId !== undefined && typeof body.afterId !== "string") throw new Error("Invalid verification cursor.");
    const snapshot = await getSnapshot();
    // Bounded groups keep the request recoverable. Existing links are never moved.
    const today=torontoDate();
    const remaining = snapshot.matters.filter(m => (inClosingView(m,"month",today) || inClosingView(m,"past",today)) && !m.driveFolderId && m.id > (body.afterId || "")).sort((a,b) => a.id.localeCompare(b.id));
    const pending = remaining.slice(0,10);
    const result = await discoverMatterFolders(pending);
    let revision = snapshot.revision;
    for (const match of result.matches) {
      const saved = await linkVerifiedFolder({id:match.matterId,folderId:match.folderId,name:match.name,rootId:match.rootId,actor:user.id,expectedRevision:revision});
      revision = saved.revision;
    }
    return NextResponse.json({ ...await getSnapshot(), linked:result.matches.length, checked:pending.length, unresolved:result.unresolved, nextCursor:remaining.length > pending.length ? pending[pending.length-1].id : null });
  } catch(error) {return NextResponse.json({error:error instanceof Error ? error.message : "Folder verification failed."},{status:409});}
}
