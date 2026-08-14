import type { Metadata } from "next";
import QuickClosingCostCalculator from "@/components/QuickClosingCostCalculator";

// The closing-cost calculator — the ONLY address it has.
//
// Staff reach it from the sidebar and see it inside the usual shell; the clerks
// an admin shares the link with open the same URL and get the page on its own,
// with no login. It sits outside /admin so src/middleware.ts (which matches only
// /admin/* and /api/admin/*) never gates it, and it is listed in
// src/lib/publicRoutes.ts so AuthProvider does not bounce an anonymous visitor
// to /admin/login and ClientLayout knows to drop the sidebar for them.
//
// /admin/calculator now redirects here. Anyone holding the URL has the full
// quoting tool, including the ability to print an unwatermarked final account on
// the firm's letterhead — the accepted trade for a link a clerk can just open.
// See src/lib/publicCalculator.ts.

export const metadata: Metadata = {
  title: "Closing cost calculator",
  description:
    "Estimate closing costs: land transfer tax, legal fees, title insurance and disbursements.",
  // Shared by link, never advertised. Keeping it out of search results is the
  // difference between "a clerk can open it" and "anyone can find it".
  robots: { index: false, follow: false },
};

export default function ClosingCostCalculatorPage() {
  // No wrapper of its own: ClientLayout supplies the background and padding for
  // a signed-in admin, and the calculator brings its own page padding either way.
  return <QuickClosingCostCalculator />;
}
