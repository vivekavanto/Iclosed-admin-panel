import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { readActiveConfig } from "@/lib/closingCostConfig";
import { buildEstimateRow, parseEstimatePayload } from "@/lib/closingEstimate";

// The purchase closing-cost estimate for one deal.
//
// There is at most ONE draft per deal (enforced by a partial unique index), and
// any number of issued rows kept as history. The customer portal reads the
// latest issued row; a draft is staff-only.
//
// Gated to admins by src/middleware.ts.

const supabase = supabaseAdmin;

/** Columns selected for both draft and issued rows. */
const ESTIMATE_COLUMNS =
  "id, deal_id, purchase_price, deposit_paid, mortgage_amount, is_toronto, " +
  "is_first_time_buyer, title_premium_override, file_no_display, rates_used, " +
  "line_items, total_closing_costs, balance_due, status, issued_at, pdf_url, " +
  "pdf_generated_at, created_by_email, created_at, updated_at";

/**
 * GET — everything the calculator page needs in one round trip:
 * the working draft, the latest issued estimate, the firm config, and prefill
 * hints derived from the file.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const { data: deal, error: dealErr } = await supabase
    .from("deals")
    .select("id, file_number, type, status, price, property_address, lead_id, is_deleted")
    .eq("id", id)
    .maybeSingle();

  if (dealErr) {
    logger.error("[ClosingEstimate GET] deal read failed:", dealErr.message);
    return NextResponse.json(
      { success: false, error: "Could not load the file" },
      { status: 500 },
    );
  }
  if (!deal || deal.is_deleted) {
    return NextResponse.json({ success: false, error: "File not found" }, { status: 404 });
  }

  const [{ data: draft }, { data: issuedRows }, { row: config, isDefault }] =
    await Promise.all([
      supabase
        .from("deal_closing_estimates")
        .select(ESTIMATE_COLUMNS)
        .eq("deal_id", id)
        .eq("status", "draft")
        .eq("is_deleted", false)
        .maybeSingle(),
      supabase
        .from("deal_closing_estimates")
        .select(ESTIMATE_COLUMNS)
        .eq("deal_id", id)
        .eq("status", "issued")
        .eq("is_deleted", false)
        .order("issued_at", { ascending: false })
        .limit(5),
      readActiveConfig(),
    ]);

  // ── Prefill hints ──
  // Purely advisory: staff always confirm them. Nothing is written back to the
  // lead, and a wrong guess only costs one click.
  let leadOwnershipHistory: string | null = null;
  let leadCity: string | null = null;
  if (deal.lead_id && isUuid(deal.lead_id)) {
    try {
      const { data: lead } = await supabase
        .from("leads")
        .select("ownership_history, address_city")
        .eq("id", deal.lead_id)
        .maybeSingle();
      leadOwnershipHistory = lead?.ownership_history ?? null;
      leadCity = lead?.address_city ?? null;
    } catch (err) {
      // Non-blocking: the hints are a convenience, not the payload.
      logger.error("[ClosingEstimate GET] lead hint lookup failed:", err);
    }
  }

  const torontoHint = /\btoronto\b/i.test(
    `${leadCity ?? ""} ${deal.property_address ?? ""}`,
  );

  return NextResponse.json({
    success: true,
    deal: {
      id: deal.id,
      file_number: deal.file_number,
      type: deal.type,
      status: deal.status,
      price: deal.price,
      property_address: deal.property_address,
    },
    draft: draft ?? null,
    latest_issued: issuedRows?.[0] ?? null,
    issued_history: issuedRows ?? [],
    config,
    config_is_default: isDefault,
    prefill: {
      purchase_price: deal.price ?? 0,
      is_toronto: torontoHint,
      // The intake question is "have you owned before?" — "No (first time)" is
      // the only answer that suggests first-time-buyer status.
      is_first_time_buyer: leadOwnershipHistory === "No (first time)",
      file_no_display: deal.file_number ?? null,
      lead_ownership_history: leadOwnershipHistory,
      lead_address_city: leadCity,
    },
  });
}

/**
 * PUT — save the working draft (upsert; one per deal).
 *
 * The statement is recomputed server-side from the raw inputs and the effective
 * rates; client-sent totals are ignored entirely.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseEstimatePayload(body);
  if ("error" in parsed) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }

  const { data: deal, error: dealErr } = await supabase
    .from("deals")
    .select("id, is_deleted")
    .eq("id", id)
    .maybeSingle();
  if (dealErr) {
    logger.error("[ClosingEstimate PUT] deal read failed:", dealErr.message);
    return NextResponse.json(
      { success: false, error: "Could not load the file" },
      { status: 500 },
    );
  }
  if (!deal || deal.is_deleted) {
    return NextResponse.json({ success: false, error: "File not found" }, { status: 404 });
  }

  const { row: config } = await readActiveConfig();
  const { columns, statement } = buildEstimateRow(parsed.payload, config);

  const { data: existing } = await supabase
    .from("deal_closing_estimates")
    .select("id, updated_at")
    .eq("deal_id", id)
    .eq("status", "draft")
    .eq("is_deleted", false)
    .maybeSingle();

  const now = new Date().toISOString();
  const actor = await getActingAdmin();

  if (existing?.id) {
    // GAP-001 style optimistic concurrency — two clerks editing the same file
    // shouldn't silently overwrite each other.
    const expectedUpdatedAt =
      typeof body.expected_updated_at === "string" ? body.expected_updated_at : null;

    let query = supabase
      .from("deal_closing_estimates")
      .update({ ...columns, updated_at: now })
      .eq("id", existing.id);
    if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);

    const { data, error } = await query.select(ESTIMATE_COLUMNS).single();
    if (error) {
      if (expectedUpdatedAt && error.code === "PGRST116") {
        return NextResponse.json(
          {
            success: false,
            conflict: true,
            error: "This estimate was changed by someone else. Reload to see the latest.",
          },
          { status: 409 },
        );
      }
      logger.error("[ClosingEstimate PUT] update failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: true, data, statement });
  }

  const { data, error } = await supabase
    .from("deal_closing_estimates")
    .insert([
      {
        ...columns,
        deal_id: id,
        status: "draft",
        created_by_email: actor.email,
        updated_at: now,
      },
    ])
    .select(ESTIMATE_COLUMNS)
    .single();

  if (error) {
    // 23505 = the one-draft-per-deal partial unique index. Two concurrent first
    // saves raced; the loser should just reload rather than see a raw DB error.
    if (error.code === "23505") {
      return NextResponse.json(
        {
          success: false,
          conflict: true,
          error: "A draft estimate was just created for this file. Reload to continue.",
        },
        { status: 409 },
      );
    }
    logger.error("[ClosingEstimate PUT] insert failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  return NextResponse.json({ success: true, data, statement });
}

/** DELETE — soft-delete the working draft. Issued rows are never removed here. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("deal_closing_estimates")
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq("deal_id", id)
    .eq("status", "draft")
    .eq("is_deleted", false)
    .select("id");

  if (error) {
    logger.error("[ClosingEstimate DELETE] failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  if (data && data.length > 0) {
    const actor = await getActingAdmin();
    await recordAudit({
      action: "closing_estimate.draft_delete",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "deal",
      resourceId: id,
      metadata: { estimate_ids: data.map((r) => r.id) },
      req,
    });
  }

  return NextResponse.json({ success: true, deleted: data?.length ?? 0 });
}
