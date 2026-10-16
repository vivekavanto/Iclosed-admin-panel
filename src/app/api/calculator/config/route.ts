import { NextResponse } from "next/server";
import {
  readActiveConfig,
  readFirms,
  readStatementTypes,
} from "@/lib/closingCostConfig";
import { STATEMENT_TYPE_KEYS } from "@/lib/closingCostSettings";
import { publicConfigView } from "@/lib/publicCalculator";
import { rateLimitOk, requestIp } from "@/lib/rateLimit";

// GET /api/calculator/config
//
// Everything the calculator at /closing-cost-calculator needs to render: the
// merged config for the default firm, the firms a clerk may pick, and the
// statement-type wording. It answers a signed-in admin and a clerk with no
// session alike — see src/lib/publicCalculator.ts for what that trade costs.
//
// PUBLIC: deliberately NOT under /api/admin, so src/middleware.ts does not gate
// it. Read-only, no session, nothing written.
//
// Every row goes out through `publicConfigView` rather than whole, so a column
// added to the config tables later is not published by accident.

export async function GET(req: Request) {
  // Generous: one cheap read per page load, and the page is meant to be opened
  // by a group of clerks. It stops a script hammering the config tables, not a
  // clerk who reloads.
  if (!(await rateLimitOk(`pub-calc-config:${requestIp(req)}`, 60, 60))) {
    return NextResponse.json(
      { success: false, error: "Too many requests. Please wait a moment and try again." },
      { status: 429 },
    );
  }

  
  const [{ row: config, isDefault, firmKey }, firms, statementTypes] =
    await Promise.all([readActiveConfig(), readFirms(), readStatementTypes()]);

  return NextResponse.json({
    success: true,
    config: publicConfigView(config),
    config_is_default: isDefault,
    // Only firms actually in use — the picker is a choice a clerk makes for a
    // live quote, not a list of every row ever created.
    firms: firms.rows
      .filter((row) => row.is_active === true)
      .map((row) => publicConfigView(row)),
    statement_types: STATEMENT_TYPE_KEYS.map((key) => statementTypes.types[key]),
    default_firm_key: firmKey,
  });
}
