import { sendEmail } from "./email/emailTransport";
import supabaseAdmin from "./supabaseAdmin";
import { interpolate } from "./sendWelcomeEmail";
import { maskEmail } from "./maskEmail";
import { decodeTemplateBraces } from "./renderEmailTemplate";
import { logger } from "./logger";
import { normalizeRecipientEmail } from "./emailIdentity";
import { getLeadFirmKey } from "./leadFirm";
import { brandEmailHtml } from "./emailBrand";
import { standingAgentCcList } from "./agentCc";
import { resolveAgent, agentTemplateValues } from "./resolveAgent";

export type AgentSignupEmailResult = {
  success: boolean;
  alreadySent?: boolean;
  skipped?: boolean;
  skipReason?: string;
  emailId?: string;
  templateUsed?: string;
  agentEmail?: string;
  error?: string;
  statusCode?: number;
};

export type AgentSignupEmailOpts = {
  /**
   * Where this trigger fires. Used only for logging.
   * - "first_login" → client's first login on the customer portal (new-lead webhook)
   * - "manual"      → an admin re-sent it
   */
  source?: "first_login" | "manual";

  /**
   * Optional explicit template selection. If omitted we look up an active
   * template whose name contains "signup" (case-insensitive) — the seeded
   * "Signup email to agents" template.
   */
  templateId?: string;
  templateName?: string;

  /**
   * When true, skip the `agent_signup_email_sent` idempotency guard. Used only
   * by a manual admin re-send. Auto-triggers (first_login) leave this false so
   * the agent is notified exactly once per lead.
   */
  bypassIdempotency?: boolean;
};

/**
 * Notifies the client's referral agent/broker that their client just signed up
 * on iClosed, using the admin-managed "Signup email to agents" template.
 *
 * Distinct from sendWelcomeEmail (which emails the CLIENT) and from the
 * `shared_with_agent` CC on milestone emails (which only copies the agent on the
 * client's own email). This one is addressed directly TO the agent.
 *
 * Only fires once the client has ACTIVATED their account (set a password / first
 * login), detected via their deal being promoted off "Inactive". Before that it
 * skips without consuming the one-shot, so a later post-activation call sends.
 *
 * Idempotent — guarded by `leads.agent_signup_email_sent`. Safe to call from the
 * new-lead webhook on every login; only the first post-activation call actually
 * sends. Silently skips (success:true) when the account isn't activated yet,
 * there's no agent on file, or no active template.
 */
export async function sendAgentSignupEmail(
  leadId: string,
  opts: AgentSignupEmailOpts = {},
): Promise<AgentSignupEmailResult> {
  if (!leadId) {
    return { success: false, error: "lead_id is required", statusCode: 400 };
  }

  // 1. Fetch the lead
  const { data: lead, error: leadError } = await supabaseAdmin
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .single();

  if (leadError || !lead) {
    return { success: false, error: "Lead not found", statusCode: 404 };
  }

  // 2. Idempotency guard
  if (lead.agent_signup_email_sent && !opts.bypassIdempotency) {
    return { success: true, alreadySent: true, templateUsed: "(already sent)" };
  }

  // 3. Gate on account activation. The agent is notified only AFTER the client
  // activates their account (sets a password / first login) — which is exactly
  // when their deal is promoted off "Inactive" to "Active" (see
  // activateClientDeals). A lead with no deal, or only "Inactive" deals, hasn't
  // activated yet, so we hold the notification; a later call (post-activation)
  // will send it. The idempotency flag is only set after an actual send, so
  // skipping here never burns the one-shot.
  const { data: leadDeals } = await supabaseAdmin
    .from("deals")
    .select("file_number, status")
    .eq("lead_id", leadId);

  const activatedDeal = (leadDeals ?? []).find(
    (d: any) => d.status && d.status !== "Inactive",
  );
  if (!activatedDeal) {
    // A file that HAS an agent and is still Inactive is the shape of a real
    // fault, not a routine skip: the client signed up, so something upstream
    // (activateClientDeals, the portal webhook) failed to promote the deal and
    // this notification is now stuck forever. It used to log at info alongside
    // the ordinary "no agent on file" case, which is why a whole class of
    // missing agent emails left no trace. Warn so it shows up.
    const pendingAgent = (await resolveAgent(lead))?.email;
    const log = pendingAgent ? logger.warn : logger.info;
    log(
      `[Agent Signup Email] Skipped — client has not activated yet (no non-Inactive deal). ` +
        `lead=${leadId} source=${opts.source ?? "unknown"}` +
        (pendingAgent ? ` — AGENT NOTIFICATION IS STUCK for ${maskEmail(pendingAgent)}` : ""),
    );
    return {
      success: true,
      skipped: true,
      skipReason: "Client account not activated yet",
    };
  }

  // Prefer an activated deal's file_number for template placeholders.
  const fileNumber: string | null =
    activatedDeal.file_number ?? (leadDeals ?? [])[0]?.file_number ?? null;

  // 4. Resolve the agent recipient — no agent means nothing to send.
  const agent = await resolveAgent(lead);
  if (!agent) {
    logger.info(
      `[Agent Signup Email] Skipped — lead has no referral agent on file. lead=${leadId} source=${opts.source ?? "unknown"}`,
    );
    return {
      success: true,
      skipped: true,
      skipReason: "No referral agent linked to this lead",
    };
  }

  const agentEmail = agent.email;

  // 5. Pick template — strict is_active handling mirrors sendWelcomeEmail: an
  // inactive matching template is a real off-switch, not a fall-through.
  let template: any = null;

  if (opts.templateId) {
    const { data } = await supabaseAdmin
      .from("email_templates")
      .select("*")
      .eq("id", opts.templateId)
      .single();
    if (data && !data.is_active) {
      logger.info(
        `[Agent Signup Email] Skipped — template "${data.name}" (id=${data.id}) is inactive. lead=${leadId} source=${opts.source ?? "unknown"}`,
      );
      return {
        success: true,
        skipped: true,
        skipReason: `Template "${data.name}" is inactive`,
        templateUsed: data.name,
      };
    }
    if (data) template = data;
  }

  if (!template) {
    const searchName = (opts.templateName || "signup").toLowerCase();
    const { data: matching } = await supabaseAdmin
      .from("email_templates")
      .select("*")
      .ilike("name", `%${searchName}%`)
      .order("created_at", { ascending: false });

    if (matching && matching.length > 0) {
      const active = matching.find((t: any) => t.is_active);
      if (!active) {
        logger.info(
          `[Agent Signup Email] Skipped — all matching templates (name~"${searchName}") are inactive. lead=${leadId} source=${opts.source ?? "unknown"}`,
        );
        return {
          success: true,
          skipped: true,
          skipReason: "Agent signup template is inactive",
          templateUsed: matching[0]?.name,
        };
      }
      template = active;
    }
  }

  if (!template?.body || template.body.trim() === "") {
    logger.info(
      `[Agent Signup Email] Skipped — no agent signup template configured. lead=${leadId} source=${opts.source ?? "unknown"}`,
    );
    return {
      success: true,
      skipped: true,
      skipReason: "No agent signup template configured",
    };
  }

  // 6. Build body. The client placeholders ({{ user.first_name }} etc.) resolve
  // to the LEAD — i.e. the agent's client — which is exactly what a "your client
  // just signed up" template refers to. Reuses the welcome email's interpolate.
  // GAP-013: decode all brace encodings (decimal/hex/named) so placeholders
  // resolve regardless of how the template editor stored the braces.
  const rawBody = decodeTemplateBraces(template.body)
    .replace(/ /g, " ");

  const agentName = agent.name;
  const agentFirst = agentName.split(/\s+/)[0] ?? "";
  const agentLast = agentName.split(/\s+/).slice(1).join(" ");
  // The agent is who this email is written to, so user.* is the agent (as in
  // agent-only milestone mail); the client stays reachable via client.*.
  const agentValues = {
    agent_first_name: agentFirst,
    agent_name: agentName,
    "user.first_name": agentFirst,
    "user.last_name": agentLast,
    "user.full_name": agentName,
    "user.get_full_name": agentName,
    "user.email": agentEmail,
  };

  const htmlBody = await interpolate(rawBody, lead, fileNumber, {
    extra: agentValues,
  });

  const rawSubject =
    template.subject && template.subject.trim() !== ""
      ? template.subject
      : template.name;
  // Subject is plain text — don't HTML-escape (single-pass still applies).
  const subject = await interpolate(rawSubject, lead, fileNumber, {
    escape: false,
    extra: agentValues,
  });

  // 7. Send — the agent hears from the firm acting on their client's file.
  const firm = await getLeadFirmKey(leadId);

  // The agent is the recipient here, so the standing staff CC applies with no
  // partner/deal contacts to resolve. Excluding the To address keeps an agent
  // off their own CC line in the (unlikely) case the two coincide.
  const ccList = standingAgentCcList([agentEmail]);

  const sendResult = await sendEmail(
    {
      to: [normalizeRecipientEmail(agentEmail)],
      ...(ccList.length > 0 ? { cc: ccList } : {}),
      subject,
      html: brandEmailHtml(htmlBody, firm),
    },
    { firm, label: "agent-signup" },
  );

  if (!sendResult.ok) {
    console.error(
      `[Agent Signup Email] send failed (source=${opts.source ?? "unknown"}):`,
      sendResult.error,
    );
    return {
      success: false,
      error: `Email send failed: ${sendResult.error}`,
      statusCode: 500,
    };
  }

  // 8. Mark sent — guards against duplicate sends from webhook retries / relogins
  const { error: updateError } = await supabaseAdmin
    .from("leads")
    .update({ agent_signup_email_sent: true })
    .eq("id", leadId);

  if (updateError) {
    console.error(
      "[Agent Signup Email] Failed to update agent_signup_email_sent:",
      updateError,
    );
  }

  // SEC-022/CMP-008: mask the recipient and omit the subject (it contains the
  // client's name/address) so PII isn't written to server logs.
  logger.info(
    `[Agent Signup Email] Sent to ${maskEmail(agentEmail)} (source=${opts.source ?? "unknown"}), id=${sendResult.id}`,
  );

  return {
    success: true,
    emailId: sendResult.id,
    templateUsed: template?.name,
    agentEmail,
  };
}
