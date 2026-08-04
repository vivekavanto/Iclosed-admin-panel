import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { readStatementTypes } from "@/lib/closingCostConfig";
import { defaultStatementType, isStatementTypeKey } from "@/lib/closingCostSettings";
import { collectStatementTypeUpdates } from "@/lib/closingCostConfigValidation";

// PUT /api/admin/closing-cost-config/statement-types/[typeKey]
//
// The client-facing wording for one flavour of statement — 'draft' (an
// estimate) or 'final' (the account). The line items and the maths are
// identical between them; only the title, the on-screen heading, the leading
// disclaimer, an optional footer note and the watermark differ.
//
// Note this is NOT deal_closing_estimates.status ('draft' | 'issued'), which is
// the workflow state. An issued estimate can still be a draft statement.
//
// The remaining disclaimer items stay in the twin src/lib/closingCosts.ts so
// the customer portal renders the same standing legal text from one source.
//
// Gated to admins by src/middleware.ts.

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ typeKey: string }> },
) {
  const { typeKey } = await params;
  if (!isStatementTypeKey(typeKey)) {
    return NextResponse.json(
      { success: false, error: "Unknown statement type" },
      { status: 404 },
    );
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

  const { error: validationError, updates } = collectStatementTypeUpdates(body);
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

  const existing = await readStatementTypes();
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

  updates.updated_at = new Date().toISOString();

  // readStatementTypes fills gaps from the code defaults and so never reports a
  // row id — look the real row up before deciding update vs insert.
  const { data: row, error: readErr } = await supabaseAdmin
    .from("closing_cost_statement_types")
    .select("id")
    .eq("type_key", typeKey)
    .eq("is_deleted", false)
    .maybeSingle();

  if (readErr) {
    logger.error("[ClosingCostStatementType PUT] read failed:", readErr.message);
    return NextResponse.json(
      { success: false, error: "Could not load the current statement type" },
      { status: 500 },
    );
  }

  let saved: Record<string, unknown> | null = null;

  if (row?.id) {
    const { data, error } = await supabaseAdmin
      .from("closing_cost_statement_types")
      .update(updates)
      .eq("id", row.id)
      .select("*")
      .single();
    if (error) {
      logger.error("[ClosingCostStatementType PUT] update failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    saved = data as Record<string, unknown>;
  } else {
    // The migration's seed was skipped for this key — create it from the code
    // defaults, which are the strings the app printed before it was editable.
    const seed: Record<string, unknown> = {
      ...defaultStatementType(typeKey),
      ...updates,
      type_key: typeKey,
      sort_order: typeKey === "draft" ? 0 : 1,
    };
    const { data, error } = await supabaseAdmin
      .from("closing_cost_statement_types")
      .insert([seed])
      .select("*")
      .single();
    if (error) {
      logger.error("[ClosingCostStatementType PUT] insert failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    saved = data as Record<string, unknown>;
  }

  // This is the text a client reads on their statement of account, so record
  // who reworded it. Best-effort — never blocks the save.
  const actor = await getActingAdmin();
  await recordAudit({
    action: "closing_cost_statement_type.update",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "closing_cost_statement_types",
    resourceId: String(saved?.id ?? ""),
    metadata: {
      type_key: typeKey,
      changed: Object.keys(updates).filter((k) => k !== "updated_at"),
    },
    req,
  });

  return NextResponse.json({ success: true, data: saved });
}
