import supabaseAdmin from "./supabaseAdmin";
import { buildAgentFiles, type PortalDeal, type PortalFile, type PortalLead, type PortalMilestone, type PortalTask } from "./agentPortal";

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

/** Every file the partner referred, keyed off partner_id on leads OR deals. */
export async function loadAgentFiles(partnerId: string): Promise<PortalFile[]> {
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
  if (roots.length === 0) return [];

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

  const dealIds = (deals ?? []).map((d) => d.id);
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
  const [{ data: stages }, { data: templates }] = await Promise.all([
    stageIds.length ? supabaseAdmin.from("stage_templates").select("id, lead_type").in("id", stageIds) : { data: [] },
    templateIds.length ? supabaseAdmin.from("task_templates").select("id, lead_type").in("id", templateIds) : { data: [] },
  ]);

  return buildAgentFiles({
    leads: (leads ?? []) as PortalLead[],
    deals: (deals ?? []) as PortalDeal[],
    milestones: (milestones ?? []) as PortalMilestone[],
    tasks: (tasks ?? []) as PortalTask[],
    stageLeadTypes: new Map((stages ?? []).map((s: { id: string; lead_type: string | null }) => [s.id, s.lead_type])),
    taskLeadTypes: new Map((templates ?? []).map((t: { id: string; lead_type: string | null }) => [t.id, t.lead_type])),
    today: torontoToday(),
  });
}

export type NotificationTemplate = { id: string; name: string; lead_type: string; milestone: string | null; order: number };

/** The task templates an agent can opt into, grouped client-side by lead_type. */
export async function loadNotificationTemplates(): Promise<NotificationTemplate[]> {
  const [{ data: templates, error }, { data: stages }] = await Promise.all([
    supabaseAdmin
      .from("task_templates")
      .select("id, name, lead_type, order_index, stage_template_id")
      .or("is_deleted.is.null,is_deleted.eq.false")
      .order("order_index", { ascending: true }),
    supabaseAdmin.from("stage_templates").select("id, name, order_index"),
  ]);
  if (error) throw error;
  const stageById = new Map((stages ?? []).map((s) => [s.id, s]));
  return (templates ?? [])
    .map((t) => {
      const stage = t.stage_template_id ? stageById.get(t.stage_template_id) : undefined;
      return {
        id: t.id,
        name: t.name,
        lead_type: t.lead_type,
        milestone: stage?.name ?? null,
        // Milestone order first, then the task's own order within it.
        order: (stage?.order_index ?? 9999) * 10000 + (t.order_index ?? 0),
      };
    })
    .sort((a, b) => a.order - b.order);
}

/** Missing table = migration not yet applied; surfaced to the UI rather than thrown. */
export const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST106"]);
