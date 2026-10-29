import type { ClubbedTask, PortalStage, PortalStep, PortalTask, StageId } from "./agentPortal.ts";
import { mortgageFromAnswers } from "./mortgageAnswer.ts";

export const TAX_CERTIFICATE_CHOICE = "Would you like us to obtain a property tax certificate?";
export const JOURNEY_TRACKING = {
  writ: "Writ search",
  tax: "Property tax certificate obtained",
  keys: "Lockbox code / keys transferred",
  ownership: "Change of ownership submitted",
} as const;
export type TrackingKey = keyof typeof JOURNEY_TRACKING;
export const trackingTitle = (key: TrackingKey, responsible: "Client" | "iClosed") =>
  `[Agent journey] ${JOURNEY_TRACKING[key]} (${responsible})`;
export function trackingKeyOf(title: string): TrackingKey | undefined {
  return (Object.keys(JOURNEY_TRACKING) as TrackingKey[]).find(key => title.startsWith(`[Agent journey] ${JOURNEY_TRACKING[key]} (`));
}
export const ownershipResponsible = (city: string | null): "Client" | "iClosed" =>
  /^(?:city of )?mississauga(?:,?\s+(?:on|ontario|canada))*$/i.test((city ?? "").trim()) ? "Client" : "iClosed";

const STAGES: { id: StageId; label: string; short: string }[] = [
  { id: "intake", label: "INTAKE", short: "Intake" },
  { id: "diligence", label: "DUE DILIGENCE", short: "Due diligence" },
  { id: "mortgage", label: "MORTGAGE INSTRUCTIONS", short: "Mortgage" },
  { id: "client_documents", label: "CLIENT DOCUMENTS", short: "Client documents" },
  { id: "signing", label: "SIGNING", short: "Signing" },
  { id: "funds", label: "CLOSING FUNDS", short: "Funds" },
  { id: "keys", label: "KEYS TRANSFERRED", short: "Keys" },
  { id: "post_closing", label: "POST CLOSING", short: "Post closing" },
];
type Definition = { key: string; stage: StageId; title: string; responsible: "Client" | "iClosed" | "Lender"; match: RegExp; required?: boolean; tracking?: TrackingKey; mortgage?: boolean };
// These match the shared DB titles, not the client's display-only task labels.
// A task takes precedence over its parent milestone: Void Cheque is currently
// attached to Home Insurance, and Tax Certificate is attached to the APS.
const ROWS: Definition[] = [
  { key: "aps", stage: "intake", title: "Purchase agreement received", responsible: "Client", match: /agreement of (?:purchase|sale)|\baps\b/, required: true },
  { key: "information", stage: "intake", title: "Client information", responsible: "Client", match: /personal info|ownership shares|hold title|solicitor info|property details|current address|independent legal advice/, required: true },
  { key: "initial_call", stage: "intake", title: "Initial call", responsible: "iClosed", match: /initial call/ },
  { key: "ids", stage: "intake", title: "IDs uploaded", responsible: "Client", match: /identif|upload.*\bids?\b/, required: true },
  { key: "verification", stage: "intake", title: "ID verification", responsible: "Client", match: /treefort|id verification/ },
  { key: "lender_contact", stage: "intake", title: "Lender contact info", responsible: "Client", match: /mortgage representative|lender contact|mortgage contact/, required: true, mortgage: true },
  { key: "title", stage: "diligence", title: "Title search", responsible: "iClosed", match: /title search/, required: true },
  { key: "writ", stage: "diligence", title: "Writ search", responsible: "iClosed", match: /writ search|sheriff.*(?:search|certificate)/, required: true, tracking: "writ" },
  { key: "status_certificate", stage: "diligence", title: "Status certificate", responsible: "Client", match: /status certificate/ },
  { key: "tax", stage: "diligence", title: "Property tax certificate", responsible: "iClosed", match: /(?:property )?tax certificate/, tracking: "tax" },
  { key: "mortgage", stage: "mortgage", title: "Received mortgage instructions", responsible: "iClosed", match: /mortgage instructions/, required: true, mortgage: true },
  { key: "insurance", stage: "client_documents", title: "Insurance", responsible: "Client", match: /insurance/, required: true },
  { key: "cheque", stage: "client_documents", title: "Void Cheque", responsible: "Client", match: /void cheque|direct deposit/, required: true },
  { key: "scheduled", stage: "signing", title: "Scheduled", responsible: "Client", match: /appointment|schedule.*sign/, required: true },
  { key: "signed", stage: "signing", title: "Completed", responsible: "iClosed", match: /documents sign|signing document/, required: true },
  { key: "client_funds", stage: "funds", title: "Client funds", responsible: "Client", match: /closing funds|client funds|deposit funds|proof of deposit/, required: true },
  { key: "lender_funds", stage: "funds", title: "Lender funds", responsible: "Lender", match: /lender funds|funds received|mortgage funds/, required: true, mortgage: true },
  { key: "closing", stage: "keys", title: "Closing completed", responsible: "iClosed", match: /transaction completed|title registered|closing completed/, required: true },
  { key: "coordination", stage: "keys", title: "Closing coordination", responsible: "iClosed", match: /closing date coordination/ },
  { key: "keys", stage: "keys", title: "Lockbox code / keys transferred", responsible: "iClosed", match: /keys transferred|key transfer|lockbox.*transfer/, required: true, tracking: "keys" },
  { key: "package", stage: "post_closing", title: "Closing package sent", responsible: "iClosed", match: /final report|closing package/, required: true },
  { key: "ownership", stage: "post_closing", title: "Change of ownership submitted", responsible: "iClosed", match: /change of ownership/, required: true, tracking: "ownership" },
  { key: "gas", stage: "post_closing", title: "Set up gas / utilities", responsible: "Client", match: /utilit|set\s*up gas|gas.*(?:setup|account)/, required: true },
];
const definition = (title: string) => {
  const lower = title.toLowerCase();
  // Verification must not be mistaken for uploading identification.
  return (/treefort|id verification/.test(lower) ? ROWS.find(r => r.key === "verification") : null) ?? ROWS.find(r => r.match.test(lower));
};
const trackable = (s: PortalStep) => s.state !== "not_applicable" && s.state !== "inactive";
export function buildPurchaseJourney(input: {
  steps: PortalStep[]; tasks: PortalTask[];
  answers: { task_id: string; field_label: string | null; value: unknown }[];
  dealOrder?: string[];
  finalReportSends?: { emailed_at: string | null }[];
  city: string | null; today: string; closingSoon: boolean;
}): PortalStage[] {
  const buckets = new Map<string, PortalStep[]>();
  const add = (key: string, step: PortalStep) => buckets.set(key, [...(buckets.get(key) ?? []), step]);
  const taskByKey = (key: string) => input.tasks.filter(t => (t.task_template_id ?? `t:${t.title.trim().toLowerCase().replace(/\s+/g, " ")}`) === key);
  const childStep = (task: ClubbedTask): PortalStep => ({ key: task.key, title: task.title, completed: task.completed,
    completedAt: task.completedAt, task, subTasks: [], attention: false,
    ...(taskByKey(task.key).every(t => t.activation_required && !t.activated_at && !trackingKeyOf(t.title)) && taskByKey(task.key).length ? {state: "inactive" as const} : {}) });

  for (const source of input.steps) {
    const main = definition(source.title);
    // Strip the opt-in decision entirely: a "yes" is not evidence of receipt.
    if (main?.key === "tax" && !trackingKeyOf(source.title)) continue;
    const retained: ClubbedTask[] = [];
    for (const task of source.subTasks) {
      const own = definition(task.title);
      if (own?.key === "tax" && !trackingKeyOf(task.title)) continue;
      if (own && own.key !== main?.key) add(own.key, childStep(task));
      else retained.push(task);
    }
    const ownTask = source.task ? childStep(source.task) : null;
    const allChildren = [source.task, ...retained].filter((t): t is ClubbedTask => !!t);
    const inactiveOnly = !source.completed && allChildren.length > 0 && allChildren.every(t => childStep(t).state === "inactive");
    // Milestone completion can depend on unrelated child tasks. The actual
    // matching task supplies this row's status whenever one exists.
    const step: PortalStep = { ...source, subTasks: retained,
      ...(inactiveOnly ? {state: "inactive" as const} : {}),
      ...(ownTask ? {completed: ownTask.completed && retained.every(t => t.completed), completedAt: ownTask.completedAt, state: ownTask.state} : {}) };
    add(main?.key ?? "other", step);
  }
  const purchaseIds = new Set(input.tasks.map(t => t.id));
  const answers = input.answers.filter(a => purchaseIds.has(a.task_id));
  const dealOfTask = new Map(input.tasks.map(t => [t.id, t.deal_id]));
  const mortgage = (input.dealOrder ?? [...new Set(input.tasks.map(t => t.deal_id))])
    .map(id => mortgageFromAnswers(answers.filter(a => dealOfTask.get(a.task_id) === id)))
    .find(amount => amount !== null);
  const noMortgage = mortgage === 0;
  const taxRequested = answers.some(a => a.field_label === TAX_CERTIFICATE_CHOICE && String(a.value).trim().toLowerCase() === "yes");

  const rows: { stage: StageId; step: PortalStep }[] = [];
  for (const row of ROWS) {
    if (row.key === "tax" && !taxRequested) continue;
    const sources = buckets.get(row.key) ?? [];
    if (!row.required && !sources.length && row.key !== "tax") continue;
    const relevant = sources.filter(trackable);
    const tracking = row.tracking;
    let completed = relevant.length > 0 && relevant.every(s => s.completed);
    // The final-report milestone can be checked off independently of emailing.
    // Only the existing successful-send stamps establish "package sent".
    const reportSends = input.finalReportSends ?? [];
    if (row.key === "package") completed = reportSends.length > 0 && reportSends.every(doc => !!doc.emailed_at);
    const inactive = sources.length > 0 && relevant.length === 0;
    const recordedClient = sources.some(s => trackingKeyOf(s.title) === "ownership" && s.title.endsWith("(Client)"));
    const responsible = row.key === "ownership" ? (recordedClient ? "Client" : ownershipResponsible(input.city)) : row.responsible;
    const notApplicable = row.mortgage && noMortgage;
    const evidence = sources.flatMap(s => [s.task, ...s.subTasks].filter((t): t is ClubbedTask => !!t));
    const evidenceTitles = sources.map(s => s.title).filter(t => !trackingKeyOf(t));
    const detail = notApplicable ? "Cash purchase — no mortgage required" : inactive ? "Waiting for the closing team to activate this task" :
      row.key === "package" ? (completed ? "All final-report documents have a recorded email send" : "Awaiting the final-report email send record") :
      row.key === "tax" ? "Client requested the certificate; the closing team records when it is obtained" :
      row.key === "gas" ? "Uses the client's Set up your utilities task, which includes gas" :
      row.key === "ownership" && responsible === "Client" ? "Client must submit for this municipality; the closing team records confirmation" :
      !sources.length ? "Awaiting a closing-team update" : undefined;
    rows.push({stage: row.stage, step: {key: `purchase:${row.key}`, title: row.title, responsible, completed: notApplicable ? false : completed,
      completedAt: row.key === "package" && completed ? reportSends.map(doc => doc.emailed_at!).sort().at(-1)! : completed ? sources.reduce<string | null>((a, s) => !a || (s.completedAt && s.completedAt > a) ? s.completedAt : a, null) : null,
      task: evidence.length === 1 ? evidence[0] : null,
      subTasks: evidence.length > 1 ? evidence : [],
      attention: !completed && !notApplicable && !inactive && (evidence.some(t => !t.completed && t.dueDate && t.dueDate.slice(0,10) < input.today) || (input.closingSoon && !["keys", "post_closing"].includes(row.stage))),
      ...(notApplicable ? {state: "not_applicable" as const} : inactive ? {state: "inactive" as const} : !sources.length && !completed ? {state: "untracked" as const} : {}),
      detail: detail ?? (evidenceTitles.length ? `Client milestone: ${evidenceTitles.join("; ")}` : undefined),
      // Only reserved staff tracking records can be edited here. Existing client
      // tasks and milestones always retain their established editing workflow.
      ...(tracking && (!sources.length || sources.every(s => !!trackingKeyOf(s.title))) ? {trackingKey: tracking} : {}),
    }});
  }
  for (const step of buckets.get("other") ?? []) rows.push({stage: "intake", step});
  return STAGES.map(stage => {
    const steps = rows.filter(r => r.stage === stage.id).map(r => r.step);
    const active = steps.filter(trackable);
    const done = active.filter(s => s.completed).length;
    return {...stage, steps, done, total: active.length,
      status: active.length > 0 && done === active.length ? "complete" : active.some(s => s.attention) ? "attention" : done > 0 ? "progress" : "not_started"};
  });
}
