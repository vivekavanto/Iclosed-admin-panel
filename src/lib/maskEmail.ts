// SEC-022 / CMP-008 — mask an email address for server logs so PII (the
// recipient's address) isn't written in plaintext. Keeps just enough to
// correlate ("j***@example.com") without exposing the full address.
export function maskEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return "(none)";
  }
  const [local, domain] = email.split("@");
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}
