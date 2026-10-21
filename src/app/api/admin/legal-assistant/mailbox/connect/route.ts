import { NextRequest, NextResponse } from "next/server";
import { getStaff } from "@/lib/orchestrator/server-auth";
import { canManageOrchestrator } from "@/lib/orchestrator/permissions";
import { beginMailboxOAuth, MAILBOX_STATE_COOKIE, mailboxAppOrigin } from "@/lib/orchestrator/mailbox-oauth";
export const runtime="nodejs";
export async function POST(request:NextRequest) {
  const user=await getStaff();if(!canManageOrchestrator(user))return NextResponse.json({error:"Administrator access required."},{status:403});
  try {
    const origin=mailboxAppOrigin();if(request.headers.get("origin")!==origin)return NextResponse.json({error:"Invalid request origin."},{status:403});
    const attempt=await beginMailboxOAuth(user!.id);const response=NextResponse.redirect(attempt.url,303);
    response.cookies.set(MAILBOX_STATE_COOKIE,attempt.state,{httpOnly:true,sameSite:"lax",secure:origin.startsWith("https:"),path:"/api/admin/legal-assistant/mailbox",maxAge:600});
    response.headers.set("Cache-Control","no-store");response.headers.set("Referrer-Policy","no-referrer");return response;
  } catch {return NextResponse.redirect(new URL("/admin/legal-assistant/connections/mailbox?result=setup_required",mailboxAppOrigin()),303);}
}
