import crypto from "node:crypto";

// Lets the portal intake skip the quote and send the retainer. Must match the portal's staffIntakeToken.ts.
const secret = () => process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DOMAIN = "staff-intake:";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(DOMAIN + payload).digest("base64url");
}

export function signStaffIntakeToken(): string {
  const payload = Buffer.from(String(Date.now() + TTL_MS), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** True when the token was signed here and hasn't expired. */
export function verifyStaffIntakeToken(token: string | null | undefined): boolean {
  if (!token || !secret()) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return false;
  }
  const expiresAt = Number(Buffer.from(payload, "base64url").toString("utf8"));
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}
