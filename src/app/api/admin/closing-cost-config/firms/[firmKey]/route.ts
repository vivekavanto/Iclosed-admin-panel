import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { readFirms, readSharedRates } from "@/lib/closingCostConfig";
import { defaultFirmRow, isFirmKey } from "@/lib/closingCostSettings";
import { collectFirmUpdates } from "@/lib/closingCostConfigValidation";

// PUT /api/admin/closing-cost-config/firms/[firmKey]
//
// One firm profile: its own legal & admin fees, its letterhead, its badge and
// its brand colour. Statutory values are NOT editable here — they live in the
// sibling ./shared route, so a bracket change is made once for both firms.
//
// The firm key is a known slug ('navawilson' | 'iclosed'), not a uuid, so it is
// validated with isFirmKey rather than isUuid.
//
// Gated to admins by src/middleware.ts.

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ firmKey: string }> },
) {
  const { firmKey } = await params;
  if (!isFirmKey(firmKey)) {
    return NextResponse.json({ success: false, error: "Unknown firm" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { error: validationError, updates } = collectFirmUpdates(body);
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

  const firms = await readFirms();
  if (!firms.schemaReady) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Run the 2026-08-03-closing-cost-firms-and-statement-types migration before saving.",
      },
      { status: 409 },
    );
  }

  const existing = firms.rows.find((row) => row.firm_key === firmKey) ?? null;
  const existingId = (existing?.id as string | null) ?? null;

  // Deactivating the last firm would leave the calculator with nothing to quote
  // from, and readActiveConfig would fall back to code defaults silently.
  if (updates.is_active === false) {
    const otherActive = firms.rows.some(
      (row) => row.firm_key !== firmKey && row.is_active === true,
    );
    if (!otherActive) {
      return NextResponse.json(
        { success: false, error: "At least one firm must stay active." },
        { status: 400 },
      );
    }
  }

  // Activating a firm whose letterhead is still placeholder text would print
  // "SET HST NUMBER" on a client's statement of account.
  if (updates.is_active === true) {
    const merged = { ...(existing ?? {}), ...updates };
    const placeholder = [
      "firm_name",
      "firm_address",
      "firm_phone",
      "firm_fax",
      "firm_hst_number",
    ].find((key) => String(merged[key] ?? "").trim().startsWith("SET "));
    if (placeholder) {
      return NextResponse.json(
        {
          success: false,
          error: "Fill in this firm's letterhead before activating it.",
        },
        { status: 400 },
      );
    }
  }

  updates.updated_at = new Date().toISOString();

  let saved: Record<string, unknown> | null = null;

  if (existingId) {
    const { data, error } = await supabaseAdmin
      .from("closing_cost_config")
      .update(updates)
      .eq("id", existingId)
      .select("*")
      .single();
    if (error) {
      logger.error("[ClosingCostFirm PUT] update failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    saved = data as Record<string, unknown>;
  } else {
    // The migration's seed was skipped for this firm — create the row from the
    // code defaults so the settings page is usable rather than stuck.
    const seed: Record<string, unknown> = {
      ...defaultFirmRow(firmKey),
      ...updates,
      firm_key: firmKey,
    };
    delete seed.id;
    const { data, error } = await supabaseAdmin
      .from("closing_cost_config")
      .insert([seed])
      .select("*")
      .single();
    if (error) {
      logger.error("[ClosingCostFirm PUT] insert failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    saved = data as Record<string, unknown>;
  }

  // If this firm just went inactive it must not remain the configured default,
  // or every estimate would silently fall back to the incumbent.
  if (updates.is_active === false) {
    const shared = await readSharedRates();
    if (!shared.isDefault && shared.row.default_firm_key === firmKey) {
      const replacement = firms.rows.find(
        (row) => row.firm_key !== firmKey && row.is_active === true,
      );
      if (replacement?.firm_key) {
        const { error } = await supabaseAdmin
          .from("closing_cost_shared_rates")
          .update({
            default_firm_key: replacement.firm_key,
            updated_at: new Date().toISOString(),
          })
          .eq("id", shared.row.id as string);
        if (error) {
          logger.error(
            "[ClosingCostFirm PUT] default firm reassignment failed:",
            error.message,
          );
        }
      }
    }
  }

  // A fee or letterhead change alters what every future client of this firm is
  // quoted and sent, so keep a durable record. Best-effort — never blocks.
  const actor = await getActingAdmin();
  await recordAudit({
    action: "closing_cost_firm.update",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "closing_cost_config",
    resourceId: String(saved?.id ?? ""),
    metadata: {
      firm_key: firmKey,
      changed: Object.keys(updates).filter((k) => k !== "updated_at"),
    },
    req,
  });

  return NextResponse.json({ success: true, data: saved });
}
