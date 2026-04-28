import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { convertSingleLead, type ConvertOneResult } from "@/lib/convertLead";

/**
 * POST /api/admin/convert-lead
 *
 * Called by the admin panel when an admin converts a lead to a deal.
 *
 * Expects body:
 * {
 *   lead_id: string,
 *   file_number?: string,
 *   closing_date?: string,
 *   convert_family?: boolean
 * }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { lead_id, file_number, closing_date, convert_family } = body as {
      lead_id: string;
      file_number?: string;
      closing_date?: string;
      convert_family?: boolean;
    };

    if (!lead_id) {
      return NextResponse.json({ success: false, error: "lead_id is required" }, { status: 400 });
    }

    const { data: selectedLead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select("*")
      .eq("id", lead_id)
      .single();

    if (leadError || !selectedLead) {
      return NextResponse.json({ success: false, error: "Lead not found" }, { status: 404 });
    }

    let effectiveConvertFamily = convert_family ?? false;

    if (!convert_family) {
      const rootId = selectedLead.parent_lead_id ?? selectedLead.id;
      const { data: familyCheck } = await supabaseAdmin
        .from("leads")
        .select("id")
        .or(`id.eq.${rootId},parent_lead_id.eq.${rootId}`);
      if (familyCheck && familyCheck.length > 1) {
        effectiveConvertFamily = true;
      }
    }

    if (!effectiveConvertFamily) {
      const one = await convertSingleLead(selectedLead, {
        file_number,
        closing_date,
        existingDealBehavior: "error",
      });

      if (!one.success) {
        return NextResponse.json(
          { success: false, error: one.error ?? "Conversion failed" },
          { status: one.statusCode ?? 500 },
        );
      }

      return NextResponse.json({
        success: true,
        deal_id: one.deal_id,
        file_number: one.file_number,
        client_id: one.client_id,
        invite_sent: one.invite_sent ?? false,
        already_has_login: one.already_has_login ?? false,
        auth_error: one.auth_error ?? null,
        message: one.invite_sent
          ? `Deal created and invite email sent to ${selectedLead.email}`
          : one.already_has_login
            ? `Deal created. User already has login access - no invite email sent.`
            : `Deal created, but invite could not be sent: ${one.auth_error || "Create login manually"}`,
      });
    }

    const rootLeadId: string = selectedLead.parent_lead_id ?? selectedLead.id;

    const { data: familyLeads, error: familyLeadsError } = await supabaseAdmin
      .from("leads")
      .select("*")
      .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

    if (familyLeadsError || !familyLeads || familyLeads.length === 0) {
      return NextResponse.json(
        { success: false, error: familyLeadsError?.message ?? "Co-purchaser family not found" },
        { status: 404 },
      );
    }

    const results: ConvertOneResult[] = [];
    let failedCount = 0;

    for (const lead of familyLeads) {
      const fileOverride = lead.id === rootLeadId ? file_number : undefined;
      const res = await convertSingleLead(lead, {
        file_number: fileOverride,
        closing_date,
        existingDealBehavior: "skip",
      });
      results.push(res);
      if (!res.success) failedCount++;
    }

    const created_count = results.filter((r) => r.created).length;
    const skipped_count = results.length - created_count;
    const invites_sent_count = results.filter((r) => r.invite_sent).length;
    const already_has_login_count = results.filter((r) => r.already_has_login).length;
    const rootResult = results.find((r) => r.lead_id === rootLeadId);

    return NextResponse.json({
      success: failedCount === 0,
      had_errors: failedCount > 0,
      failed_count: failedCount,
      created_count,
      skipped_count,
      invites_sent_count,
      already_has_login_count,
      results,
      deal_id: rootResult?.deal_id ?? null,
      file_number: rootResult?.file_number ?? null,
      client_id: rootResult?.client_id ?? null,
    });
  } catch (err) {
    console.error("POST /api/admin/convert-lead error:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
