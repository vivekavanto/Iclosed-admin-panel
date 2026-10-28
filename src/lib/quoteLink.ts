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

// Eligibility is also used by the browser; keep crypto confined to this signer.
export {hasQuote} from "./quoteEligibility";
