import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import {
  defaultConfigRow,
  readActiveConfig,
  tierError,
} from "@/lib/closingCostConfig";

// Firm-standard closing-cost rates & fees — the single active row of
// `closing_cost_config`, edited from /admin/settings/closing-costs.
//
// Rates are config rather than constants so a statutory bracket change or a fee
// increase never needs a code deploy. Already-issued estimates are unaffected:
// each carries its own frozen `rates_used` snapshot.
//
// Gated to admins by src/middleware.ts (everything under /api/admin/*).

const supabase = supabaseAdmin;

/** Numeric columns editable from the settings page, with sane bounds. */
const NUMERIC_COLUMNS: Record<string, { min: number; max: number }> = {
  reg_transfer: { min: 0, max: 100_000 },
  reg_mortgage: { min: 0, max: 100_000 },
  teraview: { min: 0, max: 100_000 },
  sheriff: { min: 0, max: 100_000 },
  legal_transfer: { min: 0, max: 1_000_000 },
  legal_mortgage: { min: 0, max: 1_000_000 },
  legal_title_submission: { min: 0, max: 1_000_000 },
  admin_fee: { min: 0, max: 1_000_000 },
  // A rate, not a percentage — 0.13 means 13%.
  hst_rate: { min: 0, max: 1 },
  rebate_ontario_max: { min: 0, max: 1_000_000 },
  rebate_toronto_max: { min: 0, max: 1_000_000 },
  title_premium_base: { min: 0, max: 1_000_000 },
  title_premium_rate: { min: 0, max: 1 },
  title_premium_min: { min: 0, max: 1_000_000 },
};

const TEXT_COLUMNS = [
  "label",
  "firm_name",
  "firm_subtitle",
  "firm_address",
  "firm_phone",
  "firm_fax",
  "firm_hst_number",
] as const;

const TIER_COLUMNS = ["ltt_tiers", "mltt_tiers"] as const;

const MAX_TEXT_LENGTH = 300;

export async function GET() {
  const { row, isDefault } = await readActiveConfig();
  return NextResponse.json({ success: true, data: row, is_default: isDefault });
}

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

  const updates: Record<string, unknown> = {};

  // Numeric fields
  for (const [key, bounds] of Object.entries(NUMERIC_COLUMNS)) {
    if (!(key in body)) continue;
    const raw = body[key];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (raw === null || raw === "" || !Number.isFinite(value)) {
      return NextResponse.json(
        { success: false, error: `${key} must be a number` },
        { status: 400 },
      );
    }
    if (value < bounds.min || value > bounds.max) {
      return NextResponse.json(
        {
          success: false,
          error: `${key} must be between ${bounds.min} and ${bounds.max}`,
        },
        { status: 400 },
      );
    }
    updates[key] = value;
  }

  // Text fields
  for (const key of TEXT_COLUMNS) {
    if (!(key in body)) continue;
    const value = String(body[key] ?? "").trim();
    if (!value) {
      return NextResponse.json(
        { success: false, error: `${key} cannot be empty` },
        { status: 400 },
      );
    }
    if (value.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        {
          success: false,
          error: `${key} must be ${MAX_TEXT_LENGTH} characters or fewer`,
        },
        { status: 400 },
      );
    }
    updates[key] = value;
  }

  // Bracket tables
  for (const key of TIER_COLUMNS) {
    if (!(key in body)) continue;
    const label =
      key === "ltt_tiers" ? "Ontario LTT brackets" : "Toronto MLTT brackets";
    const err = tierError(label, body[key]);
    if (err) {
      return NextResponse.json({ success: false, error: err }, { status: 400 });
    }
    updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { success: false, error: "No editable fields supplied" },
      { status: 400 },
    );
  }

  updates.updated_at = new Date().toISOString();

  // Upsert the singleton: update the active row, or create it if the migration's
  // seed INSERT was skipped.
  const { data: existing, error: readErr } = await supabase
    .from("closing_cost_config")
    .select("id")
    .eq("is_active", true)
    .eq("is_deleted", false)
    .maybeSingle();

  if (readErr) {
    logger.error("[ClosingCostConfig PUT] read failed:", readErr.message);
    return NextResponse.json(
      { success: false, error: "Could not load the current configuration" },
      { status: 500 },
    );
  }

  let saved: Record<string, unknown> | null = null;

  if (existing?.id) {
    const { data, error } = await supabase
      .from("closing_cost_config")
      .update(updates)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      logger.error("[ClosingCostConfig PUT] update failed:", error.message);
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 },
      );
    }
    saved = data as Record<string, unknown>;
  } else {
    const seed = { ...defaultConfigRow(), ...updates };
    delete seed.id;
    const { data, error } = await supabase
      .from("closing_cost_config")
      .insert([seed])
      .select("*")
      .single();
    if (error) {
      logger.error("[ClosingCostConfig PUT] insert failed:", error.message);
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 },
      );
    }
    saved = data as Record<string, unknown>;
  }

  // A fee/rate change alters what every future client is quoted, so keep a
  // durable record of who changed what. Best-effort — never blocks the save.
  const actor = await getActingAdmin();
  await recordAudit({
    action: "closing_cost_config.update",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "closing_cost_config",
    resourceId: String(saved?.id ?? ""),
    metadata: { changed: Object.keys(updates).filter((k) => k !== "updated_at") },
    req,
  });

  return NextResponse.json({ success: true, data: saved });
}
