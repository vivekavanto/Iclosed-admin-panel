import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";

// GET /api/admin/signing/appointments — list booked signing appointments,
// newest first, joined with the lawyer's initials/name for display. Gated to
// admins by src/middleware.ts.
//
// Supports ?status=confirmed|cancelled and ?lawyerId=<uuid> filters, both
// optional, for the admin list page's filter controls.

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const lawyerId = searchParams.get("lawyerId");

  let query = supabaseAdmin
    .from("signing_appointments")
    .select("*, lawyer:signing_lawyers(id, initials, full_name)")
    .order("start_at", { ascending: false });

  if (status === "confirmed" || status === "cancelled") {
    query = query.eq("status", status);
  }
  if (lawyerId) {
    query = query.eq("lawyer_id", lawyerId);
  }

  const { data, error } = await query;
  if (error) {
    logger.error("[SigningAppointments GET] list failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: data ?? [] });
}
