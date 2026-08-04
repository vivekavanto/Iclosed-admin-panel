import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { readFirms, readSharedRates } from "@/lib/closingCostConfig";
import { defaultSharedRow } from "@/lib/closingCostSettings";
import { collectSharedUpdates } from "@/lib/closingCostConfigValidation";

// The statutory & third-party rates every firm shares — land transfer tax
// brackets, the HST rate, the first-time-buyer rebate caps, the e-registration
// tariff and the FCT premium formula. None of these are the firm's own charge
// (none carries HST), so they live in one row rather than being duplicated per
// firm and drifting.
//
// Also holds the two staff-selectable defaults used until the per-deal firm /
// statement-type picker ships.
//
// Gated to admins by src/middleware.ts.

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { error: validationError, updates } = collectSharedUpdates(body);
  if (validationError) {
    return NextResponse.json(
      { success: false, error: validationError },
      { status: 400 },
    );
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { success: false, error: "No editable fields supplied" },
      { status: 400 },
    );
  }

  const existing = await readSharedRates();
  if (!existing.schemaReady) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Run the 2026-08-03-closing-cost-firms-and-statement-types migration before saving.",
      },
      { status: 409 },
    );
  }

  // A default firm nobody can select would silently fall back to the incumbent,
  // so refuse it here rather than surprising staff later.
  if (typeof updates.default_firm_key === "string") {
    const firms = await readFirms();
    const target = firms.rows.find((r) => r.firm_key === updates.default_firm_key);
    if (!target || target.is_active !== true) {
      return NextResponse.json(
        {
          success: false,
          error: "The default firm must be an active firm.",
        },
        { status: 400 },
      );
    }
  }

  updates.updated_at = new Date().toISOString();

  let saved: Record<string, unknown> | null = null;
  const existingId = existing.isDefault ? null : (existing.row.id as string | null);

  if (existingId) {
    const { data, error } = await supabaseAdmin
      .from("closing_cost_shared_rates")
      .update(updates)
      .eq("id", existingId)
      .select("*")
      .single();
    if (error) {
      logger.error("[ClosingCostShared PUT] update failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    saved = data as Record<string, unknown>;
  } else {
    // The migration's seed was skipped — create the singleton from the code
    // defaults so the page is usable rather than stuck.
    const seed = { ...defaultSharedRow(), ...updates };
    delete seed.id;
    const { data, error } = await supabaseAdmin
      .from("closing_cost_shared_rates")
      .insert([seed])
      .select("*")
      .single();
    if (error) {
      logger.error("[ClosingCostShared PUT] insert failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    saved = data as Record<string, unknown>;
  }

  // A statutory change alters what every future client of BOTH firms is quoted,
  // so keep a durable record of who changed what. Best-effort — never blocks.
  const actor = await getActingAdmin();
  await recordAudit({
    action: "closing_cost_shared.update",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "closing_cost_shared_rates",
    resourceId: String(saved?.id ?? ""),
    metadata: { changed: Object.keys(updates).filter((k) => k !== "updated_at") },
    req,
  });

  return NextResponse.json({ success: true, data: saved });
}
