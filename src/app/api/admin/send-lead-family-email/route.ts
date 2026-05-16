import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { sendWelcomeEmail } from "@/lib/sendWelcomeEmail";

/**
 * POST /api/admin/send-lead-family-email
 *
 * Body: { lead_id: string, template_id?: string }
 *
 * Resolves the "family" of leads (the primary + all co-purchasers / co-sellers
 * linked via parent_lead_id), deduplicates by email, then sends the chosen
 * template to each unique recipient by delegating to sendWelcomeEmail() with
 * bypassIdempotency: true. Returns a per-recipient breakdown so the UI can
 * show partial-success results.
 */
type RecipientResult = {
  lead_id: string;
  name: string;
  email: string;
  role: "primary" | "co-lead";
  success: boolean;
  template_used?: string;
  email_id?: string;
  skipped?: boolean;
  skip_reason?: string;
  error?: string;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { lead_id, template_id } = body as {
      lead_id?: string;
      template_id?: string;
    };

    if (!lead_id) {
      return NextResponse.json(
        { success: false, error: "lead_id is required" },
        { status: 400 },
      );
    }

    // 1. Fetch the lead the admin clicked on.
    const { data: clicked, error: clickedError } = await supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, email, parent_lead_id")
      .eq("id", lead_id)
      .single();

    if (clickedError || !clicked) {
      return NextResponse.json(
        { success: false, error: "Lead not found" },
        { status: 404 },
      );
    }

    // 2. Resolve the primary. If the clicked lead has a parent, fetch the
    //    parent; otherwise the clicked lead is the primary.
    let primary = clicked;
    if (clicked.parent_lead_id) {
      const { data: parent } = await supabaseAdmin
        .from("leads")
        .select("id, first_name, last_name, email, parent_lead_id")
        .eq("id", clicked.parent_lead_id)
        .single();
      if (parent) primary = parent;
    }

    // 3. Fetch all co-leads (siblings + clicked-lead if it was a co-lead).
    const { data: coLeads } = await supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, email, parent_lead_id")
      .eq("parent_lead_id", primary.id);

    const family: Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      role: "primary" | "co-lead";
    }> = [
      { ...primary, role: "primary" },
      ...((coLeads ?? []).map((l) => ({ ...l, role: "co-lead" as const }))),
    ];

    // 4. Dedupe by lowercased email; drop rows with empty email.
    const seen = new Set<string>();
    const recipients = family.filter((l) => {
      const key = (l.email ?? "").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (recipients.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No family member has a valid email address",
          total: 0,
          sent: 0,
          failed: 0,
          results: [],
        },
        { status: 400 },
      );
    }

    // 5. Send sequentially — keeps Resend rate-limit behaviour identical to
    //    today's single-recipient flow and produces deterministic per-recipient
    //    logs.
    const results: RecipientResult[] = [];
    for (const r of recipients) {
      const res = await sendWelcomeEmail(r.id, {
        templateId: template_id,
        source: "manual",
        bypassIdempotency: true,
      });

      const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "(no name)";
      results.push({
        lead_id: r.id,
        name,
        email: r.email ?? "",
        role: r.role,
        success: res.success && !res.error,
        template_used: res.templateUsed,
        email_id: res.emailId,
        skipped: res.skipped,
        skip_reason: res.skipReason,
        error: res.error,
      });
    }

    const sent = results.filter((r) => r.success && !r.skipped).length;
    const failed = results.filter((r) => !r.success).length;

    return NextResponse.json({
      success: failed === 0 && sent > 0,
      total: results.length,
      sent,
      failed,
      results,
    });
  } catch (err: any) {
    console.error("POST /api/admin/send-lead-family-email error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Server error" },
      { status: 500 },
    );
  }
}
