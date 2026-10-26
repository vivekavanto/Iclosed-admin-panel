import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { sendEmail } from "./email/emailTransport";
import { getLeadFirmKey } from "./leadFirm";
import { brandEmailHtml } from "./emailBrand";
import { normalizeRecipientEmail } from "./emailIdentity";
import { standingAgentCcList } from "./agentCc";
import { escapeHtml } from "./renderEmailTemplate";
import { recordAudit } from "./recordAudit";
import { MISSING_TABLE_CODES } from "./agentPortalData";

export type AgentMilestoneResult = { sent: string[]; reason?: "not_found" | "not_completed" | "no_template" | "no_partner" | "not_opted_in" };

/** Emails each referring agent who opted into this milestone that it completed. Never throws. */
export async function notifyAgentMilestone(milestoneId: string): Promise<AgentMilestoneResult> {
  try {
    const { data: ms } = await supabaseAdmin
      .from("milestones")
      .select("id, deal_id, title, status, stage_template_id")
      .eq("id", milestoneId)
      .maybeSingle();
    if (!ms) return { sent: [], reason: "not_found" };
    if (ms.status !== "Completed") return { sent: [], reason: "not_completed" };
    if (!ms.stage_template_id) return { sent: [], reason: "no_template" };

    const { data: deal } = await supabaseAdmin.from("deals").select("lead_id").eq("id", ms.deal_id).maybeSingle();
    const { data: lead } = deal?.lead_id
      ? await supabaseAdmin.from("leads").select("id, parent_lead_id").eq("id", deal.lead_id).maybeSingle()
      : { data: null };
    if (!lead) return { sent: [], reason: "not_found" };
    const rootId = lead.parent_lead_id ?? lead.id;

    const { data: leads } = await supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, partner_id, parent_lead_id")
      .or(`id.eq.${rootId},parent_lead_id.eq.${rootId}`)
      .eq("is_deleted", false);
    const { data: deals } = await supabaseAdmin
      .from("deals")
      .select("id, lead_id, partner_id, file_number, property_address")
      .in("lead_id", (leads ?? []).map((l) => l.id))
      .eq("is_deleted", false);
    const partnerIds = [...new Set([...(leads ?? []), ...(deals ?? [])].map((r) => r.partner_id).filter((id): id is string => !!id))];
    if (partnerIds.length === 0) return { sent: [], reason: "no_partner" };

    const { data: settings, error } = await supabaseAdmin
      .from("partner_notification_settings")
      .select("partner_id, stage_template_ids")
      .in("partner_id", partnerIds);
    if (error && !MISSING_TABLE_CODES.has(error.code)) throw error;
    const optedIn = (settings ?? []).filter((s) => (s.stage_template_ids as string[]).includes(ms.stage_template_id!)).map((s) => s.partner_id as string);
    if (optedIn.length === 0) return { sent: [], reason: "not_opted_in" };

    const { data: partners } = await supabaseAdmin
      .from("partners")
      .select("id, agent_name, agent_email")
      .in("id", optedIn)
      .eq("is_deleted", false);

    const root = (leads ?? []).find((l) => l.id === rootId);
    const client = [root?.first_name, root?.last_name].filter(Boolean).join(" ") || "your client";
    const primary = (deals ?? []).find((d) => d.lead_id === rootId) ?? deals?.[0];
    const milestone = ms.title.trim();
    const firm = await getLeadFirmKey(rootId);

    const sent: string[] = [];
    for (const p of partners ?? []) {
      if (!p.agent_email) continue;
      const to = normalizeRecipientEmail(p.agent_email);
      const cc = standingAgentCcList([to]);
      const file = [primary?.file_number, primary?.property_address].filter(Boolean).join(" · ");
      const html = `
        <p>Hi ${escapeHtml(p.agent_name?.split(" ")[0] || "there")},</p>
        <p><strong>${escapeHtml(milestone)}</strong> is now complete on ${escapeHtml(client)}'s file${file ? ` (${escapeHtml(file)})` : ""}.</p>
        <p>You are receiving this because you chose to be notified about this milestone. You can change your notification settings in your agent portal.</p>`;
      const result = await sendEmail(
        { to: [to], ...(cc.length ? { cc } : {}), subject: `${milestone} completed – ${client}`, html: brandEmailHtml(html, firm) },
        { firm, label: "agent-milestone" },
      );
      if (!result.ok) {
        logger.error(`[agent-milestone] send to partner ${p.id} failed:`, result.error);
        continue;
      }
      sent.push(to);
      await recordAudit({
        action: "partner.milestone_notification",
        resourceType: "partner",
        resourceId: p.id,
        metadata: { milestoneId: ms.id, stageTemplateId: ms.stage_template_id, milestone, fileNumber: primary?.file_number ?? null },
      });
    }
    return { sent };
  } catch (err) {
    logger.error("[agent-milestone] failed:", err);
    return { sent: [] };
  }
}
