/** Conservative evidence selection for historical replay. Not yet wired to a job worker. */
export interface HistoricalMailEvidence {
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}
export type MailEvidenceDecision =
  | { eligible: true; kind: "matter-correspondence" }
  | { eligible: false; reason: "invalid-time" | "after-cutoff" | "derived-or-bulk" | "matter-not-established" };
export function selectHistoricalMailEvidence(message: HistoricalMailEvidence, input: {
  cutoffExclusiveMs: number;
  matterNumber: string;
  subjectAliases?: string[];
}): MailEvidenceDecision {
  const timestamp = Number(message.internalDate);
  if (!message.internalDate || !Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isSafeInteger(input.cutoffExclusiveMs)) return { eligible: false, reason: "invalid-time" };
  if (timestamp >= input.cutoffExclusiveMs) return { eligible: false, reason: "after-cutoff" };
  const header = (name: string) => message.payload?.headers?.filter(h => h.name.toLowerCase() === name).map(h => h.value).join(" ") ?? "";
  const from = header("from"), subject = header("subject");
  // Do not use audit reports, firm-wide summaries or Slack digests to corroborate an audit.
  if (/@(?:[a-z0-9-]+\.)*slack\.(?:com|email)\b/i.test(from)
    || /\b(?:internal test|test only|weekly closing report|signing.package (?:audit|qa)|audit results?|workflow digest)\b/i.test(subject)
    || /\b(?:bulk|list)\b/i.test(header("precedence")) || header("list-id")) return { eligible: false, reason: "derived-or-bulk" };
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matter = normalize(input.matterNumber);
  if (!/^\d{2}[psrd]\d{4}$/.test(matter)) throw new Error("A canonical matter number is required.");
  // Subject matching is deliberately conservative. Body-only hits need separate matter verification.
  const normalizedSubject = normalize(subject);
  const aliases = input.subjectAliases?.map(normalize).filter(a => a.length >= 10) ?? [];
  const matterPattern = new RegExp(`(^|[^a-z0-9])${matter.slice(0,2)}[\\s-]*${matter[2]}[\\s-]*${matter.slice(3)}(?![a-z0-9])`, "i");
  if (!matterPattern.test(subject) && !aliases.some(a => normalizedSubject.includes(a))) return { eligible: false, reason: "matter-not-established" };
  return { eligible: true, kind: "matter-correspondence" };
}
