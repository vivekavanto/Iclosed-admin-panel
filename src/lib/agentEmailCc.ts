// WHO is copied on the emails addressed TO an agent or broker.
//
// Two sends are addressed to an agent rather than to a client:
//
//   agent-signup   "Your client just signed up on iClosed"  (sendAgentSignupEmail)
//   partner-code   "Your iClosed referral code: …"          (sendPartnerCodeEmail)
//
// Both now copy the supervising address below, so the back office sees what
// went out to the agent without the agent having to forward it.
//
// This is deliberately NOT the same thing as buildAgentCcList() in agentCc.ts.
// That one copies the AGENT on the CLIENT's mail (milestone and welcome emails,
// gated on the template's `shared_with_agent` flag). This one copies STAFF on
// the agent's own mail. Keeping them apart is what stops "copy the back office
// on agent notifications" from turning into "copy the back office on every
// client email in the system".
//
// Kept dependency-free, like clerkRecipients.ts and for the same reason: the
// senders themselves pull in Supabase and the email transport, none of which a
// unit test can load, so the routing rule lives where it can be pinned by
// tests/agentEmailCc.test.ts.

/**
 * Copied on every email addressed to an agent.
 *
 * Override with AGENT_EMAIL_CC (comma-separated, no deploy needed); set it to
 * "off" to drop the CC entirely — which is how a non-production environment
 * avoids copying a real person on test sends.
 *
 * A shipped default rather than a bare env var, matching DEFAULT_ALWAYS_CLERK:
 * an env-only rule fails silently and invisibly when the variable is missing
 * from an environment, and nobody notices a CC that never arrives.
 */
export const DEFAULT_AGENT_EMAIL_CC = "saru@iclosed.ca";

// Same loose guard as agentCc.ts. A CC is strictly less important than the
// email arriving, and Resend rejects the WHOLE send if any one address is
// malformed — so a bad value here must be dropped, never passed through, or a
// typo in the env var would silently stop every agent notification.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function splitAddresses(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The CC list for an agent-addressed email, or [] when it is switched off.
 *
 * `exclude` takes the To recipient(s), so an agent who happens to be the
 * supervising address is not CC'd on their own email — Resend would deliver two
 * copies, and the duplicate reads as a bug from the outside.
 *
 * @param exclude addresses already on the To line
 * @param onDropped notified with each address dropped as malformed, so the
 *                  caller can log it — this module stays import-free
 */
export function agentEmailCcRecipients(
  exclude: (string | null | undefined)[] = [],
  onDropped?: (address: string) => void,
): string[] {
  const configured = (process.env.AGENT_EMAIL_CC ?? DEFAULT_AGENT_EMAIL_CC).trim();
  if (!configured || configured.toLowerCase() === "off") return [];

  const excluded = new Set(
    exclude.map((e) => (e ?? "").trim().toLowerCase()).filter(Boolean),
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of splitAddresses(configured)) {
    if (!EMAIL_RE.test(address)) {
      onDropped?.(address);
      continue;
    }
    const key = address.toLowerCase();
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }

  return out;
}
