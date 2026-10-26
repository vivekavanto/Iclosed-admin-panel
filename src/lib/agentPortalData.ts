import supabaseAdmin from "./supabaseAdmin";
import { AGENT_UPLOAD_PREFIX, buildAgentFiles, type AgentUpload, type FileField, type PortalDeal, type PortalFile, type PortalLead, type PortalMilestone, type PortalTask } from "./agentPortal";

export type AgentPortalPartner = {
  id: string;
  agent_name: string | null;
  agent_email: string | null;
  brokerage_type: string | null;
  brokerage_name: string | null;
  referral_code: string | null;
};

const PARTNER_COLUMNS = "id, agent_name, agent_email, brokerage_type, brokerage_name, referral_code";
const LEAD_COLUMNS = "id, first_name, last_name, parent_lead_id";
const DEAL_COLUMNS = "id, lead_id, file_number, type, status, property_address, selling_property_address, closing_date";

export async function loadAgentPortalPartner(partnerId: string): Promise<AgentPortalPartner | null> {
  const { data } = await supabaseAdmin
    .from("partners")
    .select(PARTNER_COLUMNS)
    .eq("id", partnerId)
    .eq("is_deleted", false)
    .maybeSingle<AgentPortalPartner>();
  return data ?? null;
}

// en-CA formats as YYYY-MM-DD; closings are counted in the firm's local day.
export const torontoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());

/** Leads and deals of every family the partner referred, keyed off partner_id on leads OR deals. */
async function loadPartnerFamilies(partnerId: string): Promise<{ leads: PortalLead[]; deals: PortalDeal[] }> {
  const [{ data: linkedLeads, error: leadsErr }, { data: linkedDeals, error: dealsErr }] = await Promise.all([
    supabaseAdmin.from("leads").select("id, parent_lead_id").eq("partner_id", partnerId).eq("is_deleted", false),
    supabaseAdmin.from("deals").select("lead_id").eq("partner_id", partnerId).eq("is_deleted", false),
  ]);
  if (leadsErr) throw leadsErr;
  if (dealsErr) throw dealsErr;

  const dealLeadIds = (linkedDeals ?? []).map((d) => d.lead_id).filter((id): id is string => !!id);
  const { data: dealLeads } = dealLeadIds.length
    ? await supabaseAdmin.from("leads").select("id, parent_lead_id").in("id", dealLeadIds).eq("is_deleted", false)
    : { data: [] as { id: string; parent_lead_id: string | null }[] };

  const roots = [...new Set([...(linkedLeads ?? []), ...(dealLeads ?? [])].map((l) => l.parent_lead_id ?? l.id))];
  if (roots.length === 0) return { leads: [], deals: [] };

  const { data: leads, error: familyErr } = await supabaseAdmin
    .from("leads")
    .select(LEAD_COLUMNS)
    .or(`id.in.(${roots.join(",")}),parent_lead_id.in.(${roots.join(",")})`)
    .eq("is_deleted", false);
  if (familyErr) throw familyErr;

  const leadIds = (leads ?? []).map((l) => l.id);
  const { data: deals, error: familyDealsErr } = await supabaseAdmin
    .from("deals")
    .select(DEAL_COLUMNS)
    .in("lead_id", leadIds)
    .eq("is_deleted", false);
  if (familyDealsErr) throw familyDealsErr;
  return { leads: (leads ?? []) as PortalLead[], deals: (deals ?? []) as PortalDeal[] };
}

/** The root lead of one of the partner's files, or null. Other Documents are filed against it. */
export async function loadAgentRootLead(partnerId: string, leadId: string): Promise<string | null> {
  const { leads } = await loadPartnerFamilies(partnerId);
  return leads.some((l) => l.id === leadId && !l.parent_lead_id) ? leadId : null;
}

/** The task, if it sits on one of the partner's files; null otherwise. */
export async function loadAgentTask(partnerId: string, taskId: string) {
  const { data: task } = await supabaseAdmin
    .from("tasks")
    .select("id, deal_id, task_template_id, status")
    .eq("id", taskId)
    .eq("is_deleted", false)
    .maybeSingle();
  if (!task?.deal_id) return null;
  const { deals } = await loadPartnerFamilies(partnerId);
  const deal = deals.find((d) => d.id === task.deal_id);
  return deal ? { ...task, deal_id: task.deal_id as string, lead_id: deal.lead_id } : null;
}

/** Every file the partner referred. */
export async function loadAgentFiles(partnerId: string): Promise<PortalFile[]> {
  const { leads, deals } = await loadPartnerFamilies(partnerId);
  const dealIds = deals.map((d) => d.id);
  if (dealIds.length === 0) return [];

  const [{ data: milestones, error: msErr }, { data: tasks, error: taskErr }] = await Promise.all([
    supabaseAdmin
      .from("milestones")
      .select("id, deal_id, title, status, order_index, stage_template_id, side, completed_at")
      .in("deal_id", dealIds)
      .eq("is_deleted", false),
    supabaseAdmin
      .from("tasks")
      .select("id, deal_id, milestone_id, title, status, completed, completed_at, due_date, task_template_id, is_shared, side, order_index")
      .in("deal_id", dealIds)
      .eq("is_deleted", false),
  ]);
  if (msErr) throw msErr;
  if (taskErr) throw taskErr;

  const stageIds = [...new Set((milestones ?? []).map((m) => m.stage_template_id).filter((id): id is string => !!id))];
  const templateIds = [...new Set((tasks ?? []).map((t) => t.task_template_id).filter((id): id is string => !!id))];
  const [{ data: stages }, { data: templates }, { data: fields }] = await Promise.all([
    stageIds.length ? supabaseAdmin.from("stage_templates").select("id, lead_type").in("id", stageIds) : { data: [] },
    templateIds.length ? supabaseAdmin.from("task_templates").select("id, lead_type").in("id", templateIds) : { data: [] },
    templateIds.length
      ? supabaseAdmin
          .from("task_form_fields")
          .select("id, task_template_id, label, required")
          .in("task_template_id", templateIds)
          .eq("field_type", "file")
          .order("order_index", { ascending: true })
      : { data: [] },
  ]);

  const fileFields = new Map<string, FileField[]>();
  for (const f of (fields ?? []) as { id: string; task_template_id: string; label: string; required: boolean | null }[]) {
    fileFields.set(f.task_template_id, [...(fileFields.get(f.task_template_id) ?? []), { id: f.id, label: f.label, required: !!f.required }]);
  }
  // Which open upload tasks already hold a file, matched by field id or label like maybeCompleteFileTask.
  const openUploadTaskIds = (tasks ?? [])
    .filter((t) => !t.completed && t.status !== "Completed" && t.task_template_id && fileFields.has(t.task_template_id))
    .map((t) => t.id);
  const { data: responses } = openUploadTaskIds.length
    ? await supabaseAdmin
        .from("task_responses")
        .select("task_id, field_id, field_label")
        .in("task_id", openUploadTaskIds)
        .eq("field_type", "file")
        .not("file_url", "is", null)
    : { data: [] };
  const filledFields = new Map<string, Set<string>>();
  for (const r of (responses ?? []) as { task_id: string; field_id: string | null; field_label: string | null }[]) {
    const set = filledFields.get(r.task_id) ?? new Set<string>();
    if (r.field_id) set.add(r.field_id);
    if (r.field_label) set.add(r.field_label);
    filledFields.set(r.task_id, set);
  }

  const files = buildAgentFiles({
    leads,
    deals,
    milestones: (milestones ?? []) as PortalMilestone[],
    tasks: (tasks ?? []) as PortalTask[],
    stageLeadTypes: new Map((stages ?? []).map((s: { id: string; lead_type: string | null }) => [s.id, s.lead_type])),
    taskLeadTypes: new Map((templates ?? []).map((t: { id: string; lead_type: string | null }) => [t.id, t.lead_type])),
    today: torontoToday(),
    fileFields,
    filledFields,
  });

  // The agent's own uploads: task files and Other Documents stored under the agent prefix.
  const uploadPaths = leads.map((l) => `file_url.ilike.*/${AGENT_UPLOAD_PREFIX}/${l.id}/*`).join(",");
  const [{ data: taskUploads }, { data: otherUploads }] = leads.length
    ? await Promise.all([
        supabaseAdmin.from("task_responses").select("task_id, field_label, file_name, file_url, submitted_at").eq("field_type", "file").or(uploadPaths),
        supabaseAdmin
          .from("lead_corporate_docs")
          .select("lead_id, custom_type, file_name, file_url, created_at")
          .eq("doc_type", "other")
          .in("lead_id", leads.map((l) => l.id))
          .or(uploadPaths),
      ])
    : [{ data: [] }, { data: [] }];

  const taskById = new Map((tasks ?? []).map((t) => [t.id, t]));
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const rootOfLead = (leadId: string | null | undefined) => {
    const lead = leadId ? leadById.get(leadId) : undefined;
    return lead ? lead.parent_lead_id ?? lead.id : null;
  };
  // Mirrored shared-task rows repeat the same file, so each URL counts once.
  const byRoot = new Map<string, Map<string, AgentUpload>>();
  const add = (root: string | null, url: string, upload: AgentUpload) => {
    if (!root) return;
    const m = byRoot.get(root) ?? new Map<string, AgentUpload>();
    if (!m.has(url)) m.set(url, upload);
    byRoot.set(root, m);
  };
  for (const r of (taskUploads ?? []) as { task_id: string; field_label: string | null; file_name: string | null; file_url: string; submitted_at: string | null }[]) {
    const task = taskById.get(r.task_id);
    if (!task?.deal_id) continue;
    add(rootOfLead(dealById.get(task.deal_id)?.lead_id), r.file_url, {
      fileName: r.file_name ?? "Document",
      label: r.field_label && r.field_label.trim() !== task.title.trim() ? `${task.title.trim()} · ${r.field_label}` : task.title.trim(),
      uploadedAt: r.submitted_at,
    });
  }
  for (const d of (otherUploads ?? []) as { lead_id: string; custom_type: string | null; file_name: string | null; file_url: string; created_at: string | null }[]) {
    add(rootOfLead(d.lead_id), d.file_url, { fileName: d.file_name ?? "Document", label: d.custom_type || "Other document", uploadedAt: d.created_at });
  }
  return files.map((f) => ({
    ...f,
    agentUploads: [...(byRoot.get(f.rootLeadId)?.values() ?? [])].sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? "")),
  }));
}

export type NotificationTemplate = { id: string; name: string; lead_type: string };

/** The milestone templates an agent can opt into, grouped client-side by lead_type. */
export async function loadNotificationTemplates(): Promise<NotificationTemplate[]> {
  const { data, error } = await supabaseAdmin
    .from("stage_templates")
    .select("id, name, lead_type, order_index")
    .or("is_deleted.is.null,is_deleted.eq.false")
    .order("order_index", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((t) => ({ id: t.id, name: t.name.trim(), lead_type: t.lead_type }));
}

/** Missing table = migration not yet applied; surfaced to the UI rather than thrown. */
export const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST106"]);
