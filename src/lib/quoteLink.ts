import crypto from "node:crypto";

// Mirrors the customer app's src/lib/quoteToken.ts; both sign with the shared service-role key.
const DOMAIN = "quote:";

export function signQuoteToken(leadId: string): string {
  const payload = Buffer.from(leadId, "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "")
    .update(DOMAIN + payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

/** Lead types the customer app prices a quote for. */
export function hasQuote(leadType: string | null | undefined): boolean {
  return /purchase|sale|refinance|condo/i.test(leadType ?? "");
}
