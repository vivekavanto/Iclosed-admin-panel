import { NextResponse } from "next/server";
import {
  readActiveConfig,
  readFirms,
  readStatementTypes,
} from "@/lib/closingCostConfig";
import { STATEMENT_TYPE_KEYS } from "@/lib/closingCostSettings";

// Everything the standalone calculator at /admin/calculator needs to render:
// the merged config for the default firm, the firms a clerk may pick, and the
// statement-type wording.
//
// Deliberately the same shape as the config half of
// /api/admin/deals/[id]/closing-estimate, minus the deal, the draft and the
// prefill — this route has no file to read any of that from. Kept separate from
// /api/admin/closing-cost-config, which serves the settings EDITOR and returns
// inactive firms and schema-readiness flags that a calculator has no use for.
//
// Read-only. Gated to admins by src/middleware.ts.

export async function GET() {
  const [{ row: config, isDefault, firmKey }, firms, statementTypes] =
    await Promise.all([readActiveConfig(), readFirms(), readStatementTypes()]);

  return NextResponse.json({
    success: true,
    config,
    config_is_default: isDefault,
    // Only firms that are actually in use — the picker is a choice a clerk makes
    // for a live quote, not a list of every row ever created.
    firms: firms.rows.filter((row) => row.is_active === true),
    statement_types: STATEMENT_TYPE_KEYS.map((key) => statementTypes.types[key]),
    default_firm_key: firmKey,
  });
}
