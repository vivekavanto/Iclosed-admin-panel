import { NextRequest, NextResponse } from "next/server";
import { getStaff } from "@/lib/orchestrator/server-auth";
import { canManageOrchestrator } from "@/lib/orchestrator/permissions";
import { finishMailboxOAuth, MAILBOX_STATE_COOKIE, mailboxAppOrigin } from "@/lib/orchestrator/mailbox-oauth";
import {finishSenderOAuth,SENDER_STATE_COOKIE,validSenderState} from "@/lib/orchestrator/sender-oauth";
export const runtime="nodejs";
export async function GET(request:NextRequest) {
  const user=await getStaff();if(!canManageOrchestrator(user))return NextResponse.json({error:"Administrator access required. Sign in to Orchestrator and start again."},{status:403});
  if(validSenderState(request.cookies.get(SENDER_STATE_COOKIE)?.value,request.nextUrl.searchParams.get('state'))){
    let result='failed';try{await finishSenderOAuth({operatorId:user!.id,cookieState:request.cookies.get(SENDER_STATE_COOKIE)?.value,returnedState:request.nextUrl.searchParams.get('state'),code:request.nextUrl.searchParams.get('code'),denied:request.nextUrl.searchParams.has('error')});result='connected';}catch{/* Never expose Google tokens, codes or provider bodies. */}
    const response=NextResponse.redirect(new URL(`/admin/legal-assistant/connections/sender?result=${result}`,mailboxAppOrigin()),303);response.cookies.set(SENDER_STATE_COOKIE,'',{httpOnly:true,sameSite:'lax',secure:mailboxAppOrigin().startsWith('https:'),path:'/api/admin/legal-assistant/mailbox',maxAge:0});response.headers.set('Cache-Control','no-store');response.headers.set('Referrer-Policy','no-referrer');return response;
  }
  let result="failed";
  try {await finishMailboxOAuth({operatorId:user!.id,cookieState:request.cookies.get(MAILBOX_STATE_COOKIE)?.value,returnedState:request.nextUrl.searchParams.get("state"),code:request.nextUrl.searchParams.get("code"),denied:request.nextUrl.searchParams.has("error")});result="connected";}
  catch(error){const message=error instanceof Error?error.message:"";if(message.includes("Please authorize"))result="wrong_account";else if(message.includes("cancelled"))result="cancelled";else if(message.includes("state")||message.includes("expired")||message.includes("already used"))result="expired";}
  const response=NextResponse.redirect(new URL(`/admin/legal-assistant/connections/mailbox?result=${result}`,mailboxAppOrigin()),303);
  response.cookies.set(MAILBOX_STATE_COOKIE,"",{httpOnly:true,sameSite:"lax",secure:mailboxAppOrigin().startsWith("https:"),path:"/api/admin/legal-assistant/mailbox",maxAge:0});
  response.headers.set("Cache-Control","no-store");response.headers.set("Referrer-Policy","no-referrer");return response;
}
