import { NextResponse } from "next/server";
import { listLawyers } from "@/lib/signingConfig";

// GET /api/signing/lawyers
//
// Public route (outside /api/admin — see src/middleware.ts). Lists the
// bookable (active) lawyers for the "choose your lawyer" landing page at
// /signing. Deliberately returns only what a client needs to pick one and
// follow the link — never calendar_id or anything admin-only.

export async function GET() {
  const lawyers = await listLawyers({ activeOnly: true });
  return NextResponse.json({
    success: true,
    data: lawyers.map((l) => ({ initials: l.initials, fullName: l.full_name })),
  });
}
