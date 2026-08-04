import { NextResponse } from "next/server";
import {
  readActiveConfig,
  readFirms,
  readSharedRates,
  readStatementTypes,
} from "@/lib/closingCostConfig";
import { STATEMENT_TYPE_KEYS } from "@/lib/closingCostSettings";

// The closing-cost settings bundle — everything /admin/settings/closing-costs
// renders, in one round trip.
//
// Writes go to the three sibling routes, one per ownership boundary, because
// their blast radii differ (editing the shared rates changes what BOTH firms
// quote) and Supabase has no cross-table transaction, so a single mega-PUT
// would only pretend to be atomic:
//
//   PUT ./shared                      statutory & third-party + the defaults
//   PUT ./firms/[firmKey]             one firm's fees, letterhead and brand
//   PUT ./statement-types/[typeKey]   the draft / final wording
//
// Rates are config rather than constants so a statutory bracket change or a fee
// increase never needs a code deploy. Already-issued estimates are unaffected:
// each carries its own frozen `rates_used` snapshot.
//
// Gated to admins by src/middleware.ts (everything under /api/admin/*).

export async function GET() {
  const [firms, shared, statementTypes, active] = await Promise.all([
    readFirms(),
    readSharedRates(),
    readStatementTypes(),
    readActiveConfig(),
  ]);

  return NextResponse.json({
    success: true,
    // False until the 2026-08-03 migration has been run. The settings page uses
    // this to disable saving rather than letting a raw PostgREST error surface.
    schema_ready: firms.schemaReady && shared.schemaReady && statementTypes.schemaReady,
    firms: firms.rows,
    shared: shared.row,
    statement_types: STATEMENT_TYPE_KEYS.map((key) => statementTypes.types[key]),
    is_default: {
      firms: firms.isDefault,
      shared: shared.isDefault,
      statement_types: statementTypes.isDefault,
    },
    // The merged default-firm row, shaped exactly as this route has always
    // returned it. Kept so any older caller still gets something usable.
    data: active.row,
    default_firm_key: active.firmKey,
  });
}
