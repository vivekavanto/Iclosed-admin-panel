import { createHash } from "node:crypto";
export const AUDIT_RULESET = "signing-shadow-2026-10-21.1";
export type FindingKind = "discrepancy" | "question" | "follow_up" | "unable_to_assess";
export type Disposition = "Open" | "Implemented" | "Incorrectly flagged" | "Needs lawyer review";
export interface AuditPage { number: number; text: string; rendered: boolean; inkRatio: number | null; }
export interface AuditSource { id: string; name: string; kind: "package" | "support" | "email"; sha256: string; capturedAt: string; occurredAt?: string; pages: AuditPage[]; }
export interface AuditManifest { matterId: string; matterNumber: string; packageHash: string; cutoff: string; ruleset: string; sources: AuditSource[]; limitations: string[]; }
export interface FindingEvidence { sourceId: string; page: number; quote: string; }
export interface FinancialComparison { type:"per_diem"|"tax_reserve"|"brokerage_deposit"; baseCents:number; comparedCents:number; adjustmentCents:number; }
export interface AuditCandidate { key: string; kind: FindingKind; summary: string; action: string; proposedBlocker: boolean; claim: "text" | "blank_page" | "missing_evidence" | "manual"; financial?:FinancialComparison|null; evidence: FindingEvidence[]; }
export interface ReviewResult { findings: AuditCandidate[]; resolutions: { key: string; evidence: FindingEvidence[] }[]; coverage: string[]; }
export interface AuditFinding extends AuditCandidate { id: string; evidenceJobId?: string; resolutionEvidence?:{jobId:string;evidence:FindingEvidence[]}; disposition: Disposition; notes: string; movement: "New" | "Unchanged" | "Resolved" | "Unable to reassess"; validation: string[]; }
export interface AuditReport { matterId: string; revision: number; nextFinding: number; findings: AuditFinding[]; feedbackHistory?: {at:string;actor:string;findingId:string;disposition:Disposition;notes:string}[]; history: { jobId: string; at: string; packageHash: string; ruleset: string; cutoff: string }[]; }
export type AuditStatus = "queued" | "capturing" | "reviewing" | "completed" | "failed";
export interface AuditJob { id: string; matterId: string; matterNumber: string; packageId: string; packageHash: string; packageName: string; folderId: string; cutoff: string; ruleset: string; status: AuditStatus; actor: string; createdAt: string; updatedAt: string; lease?: string; leaseUntil?: string; error?: string; manifest?: AuditManifest; reviewerCoverage?:string[]; }
export const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const compact = (s: string) => s.replace(/\s+/g, " ").trim();
export function evidenceSupported(evidence: FindingEvidence[], manifest: AuditManifest) {
  return evidence.length > 0 && evidence.length <= 12 && evidence.every(e => {
    const source = manifest.sources.find(s => s.id === e.sourceId);
    const page = source?.pages.find(p => p.number === e.page);
    return !!source && /^[a-f0-9]{64}$/.test(source.sha256) && !!page && compact(e.quote).length >= 8 && compact(page.text).includes(compact(e.quote));
  });
}
export function validateCandidate(candidate: AuditCandidate, manifest: AuditManifest): AuditFinding {
  const result: AuditFinding = { ...candidate, evidence: candidate.evidence ?? [], id: "", disposition: "Open", notes: "", movement: "New", validation: [] };
  if (!evidenceSupported(result.evidence, manifest)) { result.kind = "unable_to_assess"; result.validation.push("Exact source/page evidence could not be verified."); }
  if (candidate.claim === "blank_page") {
    const pages = result.evidence.map(e => manifest.sources.find(s => s.id === e.sourceId)?.pages.find(p => p.number === e.page));
    // Text extraction returning an empty string is never evidence of a blank page.
    if (!pages.length || pages.some(p => !p?.rendered || p.inkRatio === null || p.inkRatio >= 0.00001)) {
      result.kind = "unable_to_assess"; result.validation.push("Blank-page claim rejected: rendering is missing or the page contains visible marks.");
    }
    // A blank page has no quote; it always needs a human comparison with an expected source page.
    result.proposedBlocker = false;
  }
  if (candidate.claim === "missing_evidence") { result.kind = "unable_to_assess"; result.validation.push("Missing evidence does not establish non-completion."); }
  if (candidate.claim === "manual" && result.kind === "discrepancy") result.kind = "question";
  if(candidate.financial){const f=candidate.financial,values=[f.baseCents,f.comparedCents,f.adjustmentCents];
    const quotedCents=result.evidence.flatMap(e=>(e.quote.match(/\b\d[\d,]*\.\d{2}\b/g)??[]).map(n=>Math.round(Number(n.replaceAll(",",""))*100)));
    const valid=values.every(v=>Number.isSafeInteger(v)&&v>=0&&(v===0||quotedCents.includes(v)));
    if(!valid){result.kind="unable_to_assess";result.validation.push("Financial inputs were not verified against the quoted amounts.");}
    else if((f.type==="per_diem"&&f.baseCents+f.adjustmentCents===f.comparedCents)||(f.type==="tax_reserve"&&f.comparedCents>=f.baseCents)||(f.type==="brokerage_deposit"&&f.comparedCents>=f.baseCents)){
      result.kind="question";result.validation.push("The quoted amounts have an ordinary arithmetic explanation. Verify timing/payment instructions rather than treating the difference as an error.");
    }
  }
  const visible = result.evidence.some(e => manifest.sources.find(s => s.id === e.sourceId)?.pages.find(p => p.number === e.page)?.rendered);
  result.proposedBlocker = result.kind === "discrepancy" && candidate.proposedBlocker && candidate.claim === "text" && visible;
  return result;
}
export function reconcileAudit(previous: AuditReport | undefined, job: AuditJob, manifest: AuditManifest, review: ReviewResult, previousManifests:Record<string,AuditManifest>={}): AuditReport {
  const report: AuditReport = structuredClone(previous ?? { matterId: job.matterId, revision: 0, nextFinding: 1, findings: [], history: [] });
  if (report.matterId !== job.matterId) throw new Error("Report belongs to another matter.");
  if (new Set(review.findings.map(f => f.key)).size !== review.findings.length) throw new Error("Duplicate finding keys in review.");
  const seen = new Set<string>();
  for (const candidate of review.findings) {
    if (!/^[a-z0-9_.-]{3,100}$/i.test(candidate.key) || !candidate.summary?.trim() || !candidate.action?.trim()) throw new Error("Invalid reviewer finding.");
    seen.add(candidate.key); const validated = validateCandidate(candidate, manifest), old = report.findings.find(f => f.key === candidate.key);
    const next: AuditFinding = { ...validated, evidenceJobId:job.id, id: old?.id ?? `F-${String(report.nextFinding++).padStart(3,"0")}`, disposition: old?.disposition ?? "Open", notes: old?.notes ?? "", movement: validated.kind === "unable_to_assess" ? "Unable to reassess" : old ? "Unchanged" : "New" };
    if(next.disposition==="Incorrectly flagged")next.proposedBlocker=false;
    if (old) report.findings[report.findings.indexOf(old)] = next; else report.findings.push(next);
  }
  for (const old of report.findings.filter(f => !seen.has(f.key))) {
    const resolution = review.resolutions.find(r => r.key === old.key);
    const prior=old.evidenceJobId?previousManifests[old.evidenceJobId]:undefined;
    const newEvidence=!!resolution&&!!prior&&resolution.evidence.some(e=>{const source=manifest.sources.find(s=>s.id===e.sourceId);return !!source&&!prior.sources.some(p=>p.sha256===source.sha256);});
    old.movement = resolution && newEvidence && evidenceSupported(resolution.evidence, manifest) ? "Resolved" : "Unable to reassess";
    if(old.movement==="Resolved"&&resolution)old.resolutionEvidence={jobId:job.id,evidence:resolution.evidence};
    if (old.movement !== "Resolved") old.validation = ["Not reported in this run; absence alone cannot resolve an earlier finding."];
    old.proposedBlocker = false;
  }
  report.revision++; report.history.push({ jobId: job.id, at: new Date().toISOString(), packageHash: job.packageHash, ruleset: job.ruleset, cutoff: job.cutoff });
  return report;
}
