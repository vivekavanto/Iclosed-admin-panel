import { NextRequest, NextResponse } from "next/server";
import { staffAuthClient } from "@/lib/orchestrator/server-auth";

export async function POST(request: NextRequest) {
  if(request.headers.get("origin")!==request.nextUrl.origin) return NextResponse.json({error:"Invalid origin."},{status:403});
  const auth=await staffAuthClient();
  await auth.auth.signOut({scope:"local"});
  return NextResponse.redirect(new URL("/admin/login",request.url),303);
}
