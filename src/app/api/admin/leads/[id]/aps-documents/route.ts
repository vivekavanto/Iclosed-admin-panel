// GET /api/admin/leads/[id]/aps-documents
//
// Every agreement on this lead's file, for the Agreement of Purchase and Sale
// section on the lead detail page. Family-wide and read from both stores — see
// leadApsDocuments.ts for why one table read is not enough.
//
// Admin-gated by middleware.ts like everything under /api/admin.

import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { loadLeadApsDocuments } from "@/lib/leadApsDocuments";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  }

  const documents = await loadLeadApsDocuments(id);

  return NextResponse.json({ success: true, documents });
}
