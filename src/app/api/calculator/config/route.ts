import { NextResponse } from "next/server";
import { readActiveConfig, readStatementType } from "@/lib/closingCostConfig";
import { publicConfigPayload } from "@/lib/publicClosingEstimate";

// GET /api/calculator/config — the firm's published fee schedule and letterhead.
//
// PUBLIC BY DESIGN. It sits outside /api/admin/*, so src/middleware.ts never
// runs on it. Nothing here is per-file, per-client or per-lead: it returns the
// same rate card the firm already prints on every statement it sends, which is
// what lets the public page recompute the statement locally on each keystroke
// instead of round-tripping.
//
// The payload is an explicit allowlist in `publicConfigPayload` — see the note
// there on why it is additive rather than "the row minus a few keys".

export const dynamic = "force-dynamic";

export async function GET() {
  const [{ row: config }, statementType] = await Promise.all([
    readActiveConfig(),
    // Always the draft flavour: a public estimator cannot produce a final
    // account, so it must never render a final account's wording.
    readStatementType("draft"),
  ]);

  return NextResponse.json(
    { success: true, ...publicConfigPayload(config, statementType) },
    {
      headers: {
        // Settings edits should reach the public page quickly, but the rate card
        // is identical for every visitor — so a short shared cache absorbs a
        // burst of traffic without a stale price surviving long.
        "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}
