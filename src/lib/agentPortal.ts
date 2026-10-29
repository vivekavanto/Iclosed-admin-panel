import { buildPurchaseJourney } from "./purchaseJourney.ts";
// Agent portal view model: an agent's referred files, with each family's
// duplicated milestones/tasks clubbed into one step, grouped for each journey
// and split by side. Dependency-free so tests/agentPortal.test.ts can pin it.

export type PortalSide = "purchase" | "sale" | "other";

export type PortalLead = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  parent_lead_id: string | null;
  // Shown on intakes staff haven't converted to a deal yet.
  lead_type?: string | null;
  address_street?: string | null;
  address_unit?: string | null;
  address_city?: string | null;
  selling_address_street?: string | null;
  selling_address_unit?: string | null;
  selling_address_city?: string | null;
  closing_date?: string | null;
};

/** Status of a referred intake that hasn't been opened as a file yet. */
export const PENDING_STATUS = "Intake submitted";

export type PortalDeal = {
  id: string;
  lead_id: string | null;
  file_number: string | null;
  type: string | null;
  status: string | null;
  property_address: string | null;
  selling_property_address: string | null;
  closing_date: string | null;
};

export type PortalMilestone = {
  id: string;
  deal_id: string;
  title: string;
  status: string | null;
  order_index: number | null;
  stage_template_id: string | null;
  side: string | null;
  completed_at: string | null;
};

export type PortalTask = {
  id: string;
  deal_id: string | null;
  milestone_id: string | null;
  title: string;
  status: string | null;
  completed: boolean | null;
  completed_at: string | null;
  due_date: string | null;
  task_template_id: string | null;
  is_shared: boolean | null;
  side: string | null;
  order_index: number | null;
  role_type?: string | null;
  activation_required?: boolean | null;
  activated_at?: string | null;
};

export type ClubbedTask = {
  key: string;
  title: string;
  completed: boolean;
  /** Clients done vs total for per-person tasks; 1/1 or 0/1 for shared ones. */
  done: number;
  total: number;
  completedAt: string | null;
  /** Earliest due date among the copies still open. */
  dueDate: string | null;
  /** Clients who still owe a per-person task. */
  waitingOn: string[];
};

/** One milestone (or a task with no milestone): a single step on the file. */
export type PortalStep = {
  key: string;
  title: string;
  completed: boolean;
  completedAt: string | null;
  /** The task that does the step's own job, folded into the step row. */
  task: ClubbedTask | null;
  /** Other tasks inside the step. */
  subTasks: ClubbedTask[];
  attention: boolean;
  responsible?: "Client" | "iClosed" | "Lender";
  state?: "not_applicable" | "inactive" | "untracked";
  detail?: string;
  trackingKey?: "writ" | "tax" | "keys" | "ownership";
};

export type StageId = "intake" | "client" | "documents" | "signing" | "closing" | "reporting" | "diligence" | "mortgage" | "client_documents" | "funds" | "keys" | "post_closing";
export type StageStatus = "complete" | "attention" | "progress" | "not_started";

export const STAGES: { id: StageId; label: string; short: string }[] = [
  { id: "intake", label: "Intake", short: "Intake" },
  { id: "client", label: "Client information", short: "Client info" },
  { id: "documents", label: "Documents", short: "Documents" },
  { id: "signing", label: "Signing", short: "Signing" },
  { id: "closing", label: "Closing & funds", short: "Closing" },
  { id: "reporting", label: "Reporting", short: "Reporting" },
];

export type PortalStage = {
  id: StageId;
  label: string;
  short: string;
  steps: PortalStep[];
  done: number;
  total: number;
  status: StageStatus;
};

/** One side of one file — a Purchase & Sale file yields two. */
export type PortalSection = {
  side: PortalSide;
  label: string;
  address: string | null;
  /** Only stages that have steps on this file. */
  stages: PortalStage[];
  done: number;
  total: number;
  pendingTasks: number;
  attention: boolean;
  nextUp: string | null;
};

export type PortalFile = {
  rootLeadId: string;
  fileNumber: string | null;
  type: string | null;
  status: string | null;
  clients: string[];
  closingDate: string | null;
  sections: PortalSection[];
  /** Whether the client lets this agent complete tasks for them. */
  permission: AgentPermission;
};

/** "requested" while the client's emailed Accept link is open. */
export type AgentPermission = {
  status: "none" | "requested" | "granted";
  grantedAt: string | null;
  requestedAt: string | null;
  requestedTo: string | null;
  declinedAt: string | null;
};

/** Files uploaded by an agent live under this Blob path, so the portal can tell them apart. */
export const AGENT_UPLOAD_PREFIX = "agent-uploads";

export type BuildInput = {
  leads: PortalLead[];
  deals: PortalDeal[];
  milestones: PortalMilestone[];
  tasks: PortalTask[];
  /** stage_template_id / task_template_id -> template lead_type. */
  stageLeadTypes: Map<string, string | null>;
  taskLeadTypes: Map<string, string | null>;
  /** YYYY-MM-DD; injected so tests are deterministic. */
  today: string;
  /** Only the decision fields needed for the journey, never full client responses. */
  finalReportSends?: { lead_id: string; emailed_at: string | null }[];
  answers?: { task_id: string; field_label: string | null; value: unknown }[];
};

/** Open pre-closing steps flag the file this many days before closing. */
export const ATTENTION_DAYS = 14;

const isDone = (t: PortalTask) => t.status === "Completed" || t.completed === true;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const latest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
const MAX = Number.MAX_SAFE_INTEGER;

export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(toYmd.slice(0, 10)) - Date.parse(fromYmd.slice(0, 10))) / 86_400_000);
}

const FILLER = new Set(["a", "an", "and", "the", "of", "to", "for", "from", "into", "our", "your", "my", "client", "clients", "book", "please", "provide", "upload", "submit", "confirm"]);
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "") || w;
const keyWords = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w)).map(stem));

/**
 * Whether a task and its milestone are the same step under two names, e.g.
 * "Signing Appointment" / "Book your signing appointment". One side's key words
 * must all appear in the other; a single-word name only matches exactly, so
 * "Deposit" alone can't swallow an unrelated task.
 */
export function samePurpose(a: string, b: string): boolean {
  const x = keyWords(a);
  const y = keyWords(b);
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  if (small.size === 0) return false;
  const contained = [...small].every((w) => large.has(w));
  return contained && (small.size >= 2 || small.size === large.size);
}

/** An exact match wins over a looser one when several tasks qualify. */
function pickMergedTask(title: string, tasks: ClubbedTask[]): ClubbedTask | null {
  return tasks.find((t) => norm(t.title) === norm(title)) ?? tasks.find((t) => samePurpose(t.title, title)) ?? null;
}

// First match wins, so the specific stages are checked before the broad ones
// ("Statement of Adjustments" is closing, "Mortgage Statement" is documents).
const STAGE_RULES: [StageId, RegExp][] = [
  ["reporting", /final report|reporting/],
  ["signing", /\bsign/],
  ["closing", /fund|disburs|utilit|transaction completed|deal completed|closing|ledger|adjustment/],
  ["intake", /agreement of purchase|initial call|intake|instructions initiated/],
  ["client", /personal info|identification|\bid\b|solicitor|representative|void cheque|direct deposit|address|property details|financial info|ownership|legal advice|borrowers documents requested/],
  ["documents", /statement|tax|rental|lockbox|insurance|title|certificate|instructions|document|review|payout/],
];

/** The stage a milestone/task title belongs to, or null when no rule matches. */
export function stageOf(title: string): StageId | null {
  const t = title.toLowerCase();
  return STAGE_RULES.find(([, re]) => re.test(t))?.[0] ?? null;
}

/**
 * Stages for milestones in the file's own order. Stages may only move forward,
 * so each one is a contiguous run of the file's sequence; the cut points are
 * chosen to disagree with the fewest name rules (ties go to the earlier stage).
 * Client-info names weigh less: details like a void cheque or forwarding
 * address are often collected late, so they shouldn't drag documents back.
 * Unrecognised titles cost nothing and simply sit between their neighbours.
 */
export function assignStages(hints: (StageId | null)[]): StageId[] {
  const n = hints.length;
  const k = STAGES.length;
  if (n === 0) return [];
  const idx = (s: StageId) => STAGES.findIndex((x) => x.id === s);
  const cost = (i: number, s: number) => (hints[i] === null || idx(hints[i]!) === s ? 0 : hints[i] === "client" ? 3 : 5);
  // best[i][s]: fewest disagreements for steps 0..i with step i in stage s.
  const best: number[][] = [];
  for (let i = 0; i < n; i++) {
    best.push([]);
    let runMin = Infinity;
    for (let s = 0; s < k; s++) {
      runMin = Math.min(runMin, i === 0 ? 0 : best[i - 1][s]);
      best[i][s] = runMin + cost(i, s);
    }
  }
  const out: StageId[] = new Array(n);
  let cap = k - 1;
  for (let i = n - 1; i >= 0; i--) {
    let pick = 0;
    for (let s = 1; s <= cap; s++) if (best[i][s] < best[i][pick]) pick = s;
    out[i] = STAGES[pick].id;
    cap = pick;
  }
  return out;
}

export function sideFrom(
  direct: string | null | undefined,
  templateLeadType: string | null | undefined,
  dealType: string | null | undefined,
): PortalSide {
  const d = (direct ?? "").toLowerCase().trim();
  if (d === "purchase" || d === "sale") return d;
  for (const raw of [templateLeadType, dealType]) {
    const lt = (raw ?? "").toLowerCase();
    const p = lt.includes("purchase");
    const s = lt.includes("sale");
    if (p && !s) return "purchase";
    if (s && !p) return "sale";
  }
  return "other";
}

const SIDE_ORDER: PortalSide[] = ["purchase", "sale", "other"];

function sideLabel(side: PortalSide, dealType: string | null): string {
  if (side === "purchase") return "Purchase";
  if (side === "sale") return "Sale";
  return dealType && !/purchase|sale/i.test(dealType) ? dealType : "General";
}

type TaskAcc = {
  key: string;
  title: string;
  order: number;
  done: number;
  total: number;
  completedAt: string | null;
  dueDate: string | null;
  shared: boolean;
  waitingOn: string[];
};

function addTask(map: Map<string, TaskAcc>, t: PortalTask, client: string) {
  const key = t.task_template_id ?? `t:${norm(t.title)}`;
  const acc = map.get(key) ?? { key, title: t.title, order: MAX, done: 0, total: 0, completedAt: null, dueDate: null, shared: false, waitingOn: [] };
  acc.shared ||= t.is_shared === true;
  acc.total += 1;
  if (isDone(t)) {
    acc.done += 1;
    acc.completedAt = latest(acc.completedAt, t.completed_at);
  } else {
    acc.dueDate = earliest(acc.dueDate, t.due_date);
    if (client && !acc.waitingOn.includes(client)) acc.waitingOn.push(client);
  }
  acc.order = Math.min(acc.order, t.order_index ?? MAX);
  map.set(key, acc);
}

function finishTasks(map: Map<string, TaskAcc>): ClubbedTask[] {
  return [...map.values()]
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map(({ key, title, done, total, completedAt, dueDate, shared, waitingOn }) => {
      const completed = done === total;
      // A shared task is one task mirrored onto every family deal, so it counts once.
      return {
        key,
        title,
        completed,
        done: shared ? +completed : done,
        total: shared ? 1 : total,
        completedAt: completed ? completedAt : null,
        dueDate: completed ? null : dueDate,
        waitingOn: shared || completed ? [] : waitingOn,
      };
    });
}

const PRE_CLOSING = new Set<StageId>(["intake", "client", "documents", "signing"]);

function stageStatus(steps: PortalStep[]): StageStatus {
  const done = steps.filter((s) => s.completed).length;
  if (done === steps.length) return "complete";
  if (steps.some((s) => s.attention)) return "attention";
  return done > 0 ? "progress" : "not_started";
}

export function buildAgentFiles(input: BuildInput): PortalFile[] {
  const leadById = new Map(input.leads.map((l) => [l.id, l]));
  const nameOf = (l?: PortalLead) => (l ? `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim() : "");
  const rootOf = (leadId: string | null) => {
    const lead = leadId ? leadById.get(leadId) : undefined;
    return lead ? lead.parent_lead_id ?? lead.id : null;
  };

  const dealsByRoot = new Map<string, PortalDeal[]>();
  for (const d of input.deals) {
    const root = rootOf(d.lead_id);
    if (!root) continue;
    dealsByRoot.set(root, [...(dealsByRoot.get(root) ?? []), d]);
  }

  const milestonesByDeal = new Map<string, PortalMilestone[]>();
  for (const m of input.milestones) milestonesByDeal.set(m.deal_id, [...(milestonesByDeal.get(m.deal_id) ?? []), m]);
  const tasksByDeal = new Map<string, PortalTask[]>();
  for (const t of input.tasks) if (t.deal_id) tasksByDeal.set(t.deal_id, [...(tasksByDeal.get(t.deal_id) ?? []), t]);

  const files: PortalFile[] = [];
  for (const [rootLeadId, deals] of dealsByRoot) {
    // The root lead's deal carries the file's canonical type (P&S for both sides).
    const primary = deals.find((d) => d.lead_id === rootLeadId) ?? deals[0];
    const dealById = new Map(deals.map((d) => [d.id, d]));
    const clientOf = (dealId: string) => nameOf(leadById.get(dealById.get(dealId)?.lead_id ?? ""));
    const closed = primary.status === "Closed" || primary.status === "Cancelled";
    const daysToClose = primary.closing_date ? daysBetween(input.today, primary.closing_date) : null;
    const closingSoon = !closed && daysToClose !== null && daysToClose <= ATTENTION_DAYS;

    type StepAcc = { key: string; title: string; order: number; copies: PortalMilestone[]; tasks: Map<string, TaskAcc> };
    const sections = new Map<PortalSide, Map<string, StepAcc>>();
    const sectionFor = (side: PortalSide) => {
      let s = sections.get(side);
      if (!s) sections.set(side, (s = new Map()));
      return s;
    };

    // Milestone id -> clubbed step, so tasks can find their group.
    const stepById = new Map<string, StepAcc>();
    for (const d of deals) {
      for (const m of milestonesByDeal.get(d.id) ?? []) {
        const side = sideFrom(m.side, m.stage_template_id ? input.stageLeadTypes.get(m.stage_template_id) : null, primary.type);
        const key = `${side}:${m.stage_template_id ?? norm(m.title)}`;
        const sec = sectionFor(side);
        const acc: StepAcc = sec.get(key) ?? { key, title: m.title.trim(), order: MAX, copies: [], tasks: new Map() };
        acc.copies.push(m);
        acc.order = Math.min(acc.order, m.order_index ?? MAX);
        sec.set(key, acc);
        stepById.set(m.id, acc);
      }
    }

    for (const d of deals) {
      for (const t of tasksByDeal.get(d.id) ?? []) {
        let step = t.milestone_id ? stepById.get(t.milestone_id) : undefined;
        if (!step) {
          // A task with no milestone becomes a step of its own.
          const side = sideFrom(t.side, t.task_template_id ? input.taskLeadTypes.get(t.task_template_id) : null, d.type ?? primary.type);
          const sec = sectionFor(side);
          const key = `${side}:task:${t.task_template_id ?? norm(t.title)}`;
          step = sec.get(key) ?? { key, title: t.title.trim(), order: t.order_index ?? MAX, copies: [], tasks: new Map() };
          sec.set(key, step);
        }
        addTask(step.tasks, t, clientOf(d.id));
      }
    }

    const builtSections: PortalSection[] = SIDE_ORDER.filter((s) => sections.has(s)).map((side) => {
      const ordered = [...sections.get(side)!.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
      const byStage = new Map<StageId, PortalStep[]>();
      // Milestones keep the file's sequence; tasks with no milestone have no
      // place in it, so they go to the end of the stage their name suggests.
      const milestoneSteps = ordered.filter((a) => a.copies.length > 0);
      const stageFor = new Map<StepAcc, StageId>();
      assignStages(milestoneSteps.map((a) => stageOf(a.title))).forEach((s, i) => stageFor.set(milestoneSteps[i], s));
      for (const acc of [...milestoneSteps, ...ordered.filter((a) => a.copies.length === 0)]) {
        const allTasks = finishTasks(acc.tasks);
        const task = acc.copies.length ? pickMergedTask(acc.title, allTasks) : allTasks[0] ?? null;
        const subTasks = allTasks.filter((t) => t !== task);
        const completed = acc.copies.length ? acc.copies.every((c) => c.status === "Completed") : allTasks.every((t) => t.completed);
        const completedAt = completed
          ? acc.copies.reduce<string | null>((x, c) => latest(x, c.completed_at), task?.completedAt ?? null)
          : null;
        const stage: StageId = stageFor.get(acc) ?? stageOf(acc.title) ?? "client";
        const overdue = allTasks.some((t) => !t.completed && t.dueDate && t.dueDate.slice(0, 10) < input.today);
        const attention = !completed && (overdue || (closingSoon && PRE_CLOSING.has(stage)));
        byStage.set(stage, [...(byStage.get(stage) ?? []), { key: acc.key, title: acc.title, completed, completedAt, task, subTasks, attention }]);
      }

      let stages: PortalStage[] = STAGES.filter((s) => byStage.has(s.id)).map((s) => {
        const steps = byStage.get(s.id)!;
        return { ...s, steps, done: steps.filter((x) => x.completed).length, total: steps.length, status: stageStatus(steps) };
      });
      if (side === "purchase") {
        const purchaseTasks = deals.flatMap(d => tasksByDeal.get(d.id) ?? []).filter(t => {
          const parent = t.milestone_id ? input.milestones.find(m => m.id === t.milestone_id) : undefined;
          return sideFrom(t.side ?? parent?.side, t.task_template_id ? input.taskLeadTypes.get(t.task_template_id) : parent?.stage_template_id ? input.stageLeadTypes.get(parent.stage_template_id) : null, primary.type) === "purchase";
        });
        stages = buildPurchaseJourney({ steps: stages.flatMap(s => s.steps), tasks: purchaseTasks,
          answers: input.answers ?? [], city: leadById.get(rootLeadId)?.address_city ?? null,
          today: input.today, closingSoon,
          dealOrder: [primary.id, ...deals.filter(d => d.id !== primary.id).map(d => d.id)],
          finalReportSends: input.finalReportSends?.filter(doc => deals.some(d => d.lead_id === doc.lead_id)) });
      }
      const steps = stages.flatMap((s) => s.steps).filter(s => s.state !== "not_applicable" && s.state !== "inactive");
      const next = steps.find((s) => !s.completed);
      return {
        side,
        label: sideLabel(side, primary.type),
        address: side === "sale" && primary.selling_property_address ? primary.selling_property_address : primary.property_address,
        stages,
        done: steps.filter((s) => s.completed).length,
        total: steps.length,
        pendingTasks: side === "purchase" ? steps.filter(s => !s.completed).length : steps.reduce((n, s) => n + (s.completed ? 0 : 1) + s.subTasks.filter((t) => !t.completed).length, 0),
        attention: steps.some((s) => s.attention),
        nextUp: next?.title ?? null,
      };
    });

    const clients = deals
      .map((d) => (d.lead_id ? leadById.get(d.lead_id) : undefined))
      .filter((l): l is PortalLead => !!l)
      .sort((a, b) => (a.id === rootLeadId ? -1 : b.id === rootLeadId ? 1 : 0))
      .map((l) => nameOf(l))
      .filter((n, i, arr) => n && arr.indexOf(n) === i);

    files.push({
      rootLeadId,
      fileNumber: primary.file_number,
      type: primary.type,
      status: primary.status,
      clients,
      closingDate: primary.closing_date,
      sections: builtSections,
      permission: { status: "none", grantedAt: null, requestedAt: null, requestedTo: null, declinedAt: null },
    });
  }

  // Intakes not yet converted: no deal or tasks, just who and where.
  const address = (...parts: (string | null | undefined)[]) => parts.map((p) => p?.trim()).filter(Boolean).join(", ") || null;
  for (const lead of input.leads) {
    if (lead.parent_lead_id || dealsByRoot.has(lead.id)) continue;
    const both = lead.lead_type === "Purchase & Sale";
    const sides: PortalSide[] = both ? ["purchase", "sale"] : lead.lead_type === "Purchase" ? ["purchase"] : lead.lead_type === "Sale" ? ["sale"] : ["other"];
    const main = address(lead.address_street, lead.address_unit, lead.address_city);
    const selling = address(lead.selling_address_street, lead.selling_address_unit, lead.selling_address_city);
    files.push({
      rootLeadId: lead.id,
      fileNumber: null,
      type: lead.lead_type ?? null,
      status: PENDING_STATUS,
      clients: input.leads
        .filter((l) => l.id === lead.id || l.parent_lead_id === lead.id)
        .map((l) => nameOf(l))
        .filter((n, i, arr) => n && arr.indexOf(n) === i),
      closingDate: lead.closing_date ?? null,
      sections: sides.map((side) => ({
        side,
        label: sideLabel(side, lead.lead_type ?? null),
        address: both && side === "sale" ? selling : main,
        stages: [],
        done: 0,
        total: 0,
        pendingTasks: 0,
        attention: false,
        nextUp: null,
      })),
      permission: { status: "none", grantedAt: null, requestedAt: null, requestedTo: null, declinedAt: null },
    });
  }

  // Pending intakes first, then files newest number first.
  return files.sort((a, b) => Number(!!a.fileNumber) - Number(!!b.fileNumber) || (b.fileNumber ?? "").localeCompare(a.fileNumber ?? ""));
}
