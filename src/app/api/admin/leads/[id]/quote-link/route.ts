import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { hasQuote, signQuoteToken } from "@/lib/quoteLink";

/** Staff-preview link to the quote page the client was sent. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid lead id" }, { status: 400 });
  }

  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("id, lead_type")
    .eq("id", id)
    .maybeSingle();
  if (!lead) {
    return NextResponse.json({ success: false, error: "Lead not found" }, { status: 404 });
  }
  if (!hasQuote(lead.lead_type)) {
    return NextResponse.json({ success: false, error: "This lead type has no quote." }, { status: 400 });
  }

  const portal = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://dev.iclosed.ca").replace(/\/+$/, "");
  return NextResponse.json({
    success: true,
    url: `${portal}/quote/${signQuoteToken(lead.id)}?preview=1`,
  });
}
