import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import {
  sendRetainerLinkEmail,
  retainerSidesForLeadType,
} from "@/lib/sendRetainerLink";

/**
 * POST /api/admin/send-retainer-link
 *
 * Admin-gated (the middleware cookie gate covers /api/admin/*). Sends the
 * "review and sign your retainer" link to the parties on a deal's family —
 * one email per party per required side (a combined Purchase & Sale primary
 * gets two; everyone else one). The party can sign WITHOUT an account.
 *
 * Body:
 *   { deal_id: string, lead_ids?: string[] }
 *     - deal_id   : resolves the whole family (primary + co-leads).
 *     - lead_ids  : optional filter — only send to these family members.
 *
 * Response:
 *   { success, results: Array<{
 *       lead_id, name, email, side, status: "sent"|"skipped"|"error", reason?
 *   }> }
 */
type RecipientResult = {
  lead_id: string;
  name: string;
  email: string | null;
  side: "purchase" | "sale" | null;
  status: "sent" | "skipped" | "error";
  reason?: string;
};

export async function POST(req: Request) {
  let body: { deal_id?: string; lead_ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const dealId = String(body.deal_id ?? "").trim();
  if (!dealId) {
    return NextResponse.json(
      { success: false, error: "deal_id is required" },
      { status: 400 },
    );
  }

  // ── Resolve the deal → its lead → the family's ROOT lead ──────────────────
  const { data: deal, error: dealError } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id")
    .eq("id", dealId)
    .single();

  if (dealError || !deal || !deal.lead_id) {
    return NextResponse.json(
      { success: false, error: "Deal not found" },
      { status: 404 },
    );
  }

  const { data: thisLead, error: thisLeadError } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", deal.lead_id)
    .single();

  if (thisLeadError || !thisLead) {
    return NextResponse.json(
      { success: false, error: "Linked lead not found" },
      { status: 404 },
    );
  }

  const rootLeadId = thisLead.parent_lead_id ?? thisLead.id;

  const { data: familyLeads, error: familyError } = await supabaseAdmin
    .from("leads")
    .select("id, first_name, last_name, email, lead_type, parent_lead_id")
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`)
    .eq("is_deleted", false);

  if (familyError) {
    return NextResponse.json(
      { success: false, error: familyError.message },
      { status: 500 },
    );
  }

  const filter =
    Array.isArray(body.lead_ids) && body.lead_ids.length > 0
      ? new Set(body.lead_ids.map(String))
      : null;

  const targets = (familyLeads ?? []).filter(
    (l) => !filter || filter.has(l.id),
  );

  const results: RecipientResult[] = [];

  for (const lead of targets) {
    const name = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
    const email = (lead.email ?? "").trim() || null;
    const sides = retainerSidesForLeadType(lead.lead_type);

    for (const side of sides) {
      if (!email) {
        results.push({
          lead_id: lead.id,
          name,
          email: null,
          side,
          status: "skipped",
          reason: "no email",
        });
        continue;
      }

      const res = await sendRetainerLinkEmail({
        email,
        leadId: lead.id,
        side,
        primaryLeadId: rootLeadId,
      });

      results.push({
        lead_id: lead.id,
        name,
        email,
        side,
        status: res.success ? "sent" : "error",
        reason: res.success ? undefined : res.error,
      });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;

  return NextResponse.json({
    success: true,
    sent,
    total: results.length,
    results,
  });
}
