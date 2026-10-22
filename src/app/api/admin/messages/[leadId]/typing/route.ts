import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { pingStaffTyping } from "@/lib/chatRealtime";

// POST /api/admin/messages/[leadId]/typing — staff are typing a REPLY (never a
// private note) in this file's thread: the client's widget shows three dots.
// The inbox throttles this to one call per few seconds; the ping carries no
// text and no name. No-op when realtime is off.
//
// Gated to the Messages module by src/middleware.ts.

type Ctx = { params: Promise<{ leadId: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  const { leadId } = await params;
  if (!isUuid(leadId)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }
  await pingStaffTyping(leadId);
  return NextResponse.json({ success: true });
}
