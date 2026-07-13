import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { sendPartnerCodeEmail } from "@/lib/sendPartnerCodeEmail";

// POST /api/admin/partners/send-code { id } — email a partner their referral
// code. Used by the Add-modal "Email code" and the list "Resend code" buttons.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = body?.id;

  if (!id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  const { data: partner, error } = await supabaseAdmin
    .from("brokers")
    .select("id, name, email, referral_code")
    .eq("id", id)
    .eq("is_deleted", false)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!partner) {
    return NextResponse.json({ error: "Partner not found" }, { status: 404 });
  }

  const result = await sendPartnerCodeEmail(partner);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
