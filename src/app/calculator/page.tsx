import type { Metadata } from "next";
import PublicClosingCostCalculator from "@/components/PublicClosingCostCalculator";
import { readActiveConfig, readStatementType } from "@/lib/closingCostConfig";
import { publicConfigPayload } from "@/lib/publicClosingEstimate";

// The shareable closing-cost estimator: /calculator
//
// PUBLIC — no session, no file, no lead. Anyone with the link can type their own
// numbers and get the firm's published fee schedule applied to them.
//
// Two gates had to be told about it, both on the CLIENT side; the server-side
// middleware already ignores anything outside /admin/* and /api/admin/*. See
// src/lib/publicRoutes.ts for why AuthProvider and ClientLayout each need the
// exemption.

/**
 * ISR. The rate card is identical for every visitor and changes only when a
 * staff member edits Settings, so the page is served static and re-rendered at
 * most once a minute — the same freshness contract /api/calculator/config
 * publishes in its Cache-Control header.
 */
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Closing Cost Calculator | iClosed",
  description:
    "Estimate the land transfer tax, title insurance, disbursements and legal fees on an Ontario home purchase — and see the funds you'll need on closing day.",
  // A calculator is only useful with today's fee schedule behind it, and it is
  // the same page for everyone, so it is indexable.
  robots: { index: true, follow: true },
  openGraph: {
    title: "Closing Cost Calculator",
    description:
      "Estimate your Ontario home purchase closing costs and the funds you'll need on closing day.",
    type: "website",
  },
};

export default async function CalculatorPage() {
  // Resolved HERE rather than fetched from the browser, so the first paint
  // already carries the firm's real figures.
  //
  // Fetching client-side meant the statement rendered twice: once from
  // DEFAULT_RATES with no Statement of Adjustments figure, then again a moment
  // later with the firm's — so the headline visibly jumped ($2,105.89 →
  // $3,105.89 on an untouched form). A number that corrects itself in front of
  // the visitor undermines the one thing this page is for.
  //
  // Only `publicConfigPayload`'s allowlist crosses into the client component;
  // `readActiveConfig` and the service-role client stay on the server. Both
  // readers degrade to code defaults rather than throwing, so an unreachable
  // database costs correct figures, never the page.
  const [{ row: config }, statementType] = await Promise.all([
    readActiveConfig(),
    readStatementType("draft"),
  ]);

  return (
    <PublicClosingCostCalculator
      initialConfig={publicConfigPayload(config, statementType)}
    />
  );
}
