import { Resend } from "resend";
import supabaseAdmin from "./supabaseAdmin";
import { interpolate } from "./sendWelcomeEmail";
import { maskEmail } from "./maskEmail";
import { decodeTemplateBraces } from "./renderEmailTemplate";
import { logger } from "./logger";
import { EMAIL_REPLY_TO } from "./emailConfig";

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
 * Resolves the agent email from a SINGLE lead row's own fields.
 *
 * Two ways a lead can carry an agent:
 *  1. They applied a partner's referral code at intake → leads.partner_id points
 *     at the partners master; partners.agent_email is the agent's address.
 *  2. They had no code and named an off-system agent → the free-text
 *     leads.referral_agent_email.
 *
 * The linked partner wins; the free-text field is the fallback. Soft-deleted
 * partners are ignored (the FK is ON DELETE SET NULL, but a soft delete only
 * flips is_deleted, so we filter it explicitly). Returns null when this lead
 * carries no agent — the caller decides whether to fall back to the parent.
 */
async function resolveAgentEmailForLead(lead: any): Promise<string | null> {
  if (lead?.partner_id) {
    const { data: partner } = await supabaseAdmin
      .from("partners")
      .select("agent_email")
      .eq("id", lead.partner_id)
      .eq("is_deleted", false)
      .maybeSingle();
    const email = partner?.agent_email?.trim();
    if (email) return email;
  }

  const freeText = (lead?.referral_agent_email ?? "").trim();
  return freeText || null;
}

/**
 * Resolves the email of the client's referral agent/broker for the notification.
 *
 * Co-purchasers / co-sellers are stored as SEPARATE lead rows (parent_lead_id
 * set) and do NOT carry the referral link — it lives only on the primary lead
 * (verified: 0 of the co-leads on file have their own partner_id). So when a
 * co-client signs up we fall back to the parent lead's agent, so the referring
 * agent is still notified for every person on the deal, not just the primary.
 *
 * Returns null when neither the lead nor its parent has an agent on file — a
 * normal, non-error case (direct sign-ups have no referrer).
 */
async function resolveAgentEmail(lead: any): Promise<string | null> {
  // The lead's own agent link wins.
  const own = await resolveAgentEmailForLead(lead);
  if (own) return own;

  // Co-lead fallback: inherit the primary lead's agent.
  if (lead?.parent_lead_id) {
    const { data: parent } = await supabaseAdmin
      .from("leads")
      .select("partner_id, referral_agent_email")
      .eq("id", lead.parent_lead_id)
      .maybeSingle();
    if (parent) return resolveAgentEmailForLead(parent);
  }

  return null;
}

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
    logger.info(
      `[Agent Signup Email] Skipped — client has not activated yet (no non-Inactive deal). lead=${leadId} source=${opts.source ?? "unknown"}`,
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
  const agentEmail = await resolveAgentEmail(lead);
  if (!agentEmail) {
    logger.info(
      `[Agent Signup Email] Skipped — lead has no referral agent on file. lead=${leadId} source=${opts.source ?? "unknown"}`,
    );
    return {
      success: true,
      skipped: true,
      skipReason: "No referral agent linked to this lead",
    };
  }

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

  const htmlBody = await interpolate(rawBody, lead, fileNumber);

  const rawSubject =
    template.subject && template.subject.trim() !== ""
      ? template.subject
      : template.name;
  // Subject is plain text — don't HTML-escape (single-pass still applies).
  const subject = await interpolate(rawSubject, lead, fileNumber, {
    escape: false,
  });

  // 7. Send
  if (!process.env.RESEND_API_KEY) {
    return {
      success: false,
      error: "Email service not configured (missing RESEND_API_KEY)",
      statusCode: 500,
    };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>";

  const { data: sendResult, error: sendError } = await resend.emails.send({
    from: fromEmail,
    replyTo: EMAIL_REPLY_TO,
    to: [agentEmail],
    subject,
    html: htmlBody,
  });

  if (sendError) {
    console.error(
      `[Agent Signup Email] Resend error (source=${opts.source ?? "unknown"}):`,
      sendError,
    );
    return {
      success: false,
      error: `Email send failed: ${sendError.message}`,
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
    `[Agent Signup Email] Sent to ${maskEmail(agentEmail)} (source=${opts.source ?? "unknown"}), id=${sendResult?.id}`,
  );

  return {
    success: true,
    emailId: sendResult?.id,
    templateUsed: template?.name,
    agentEmail,
  };
}
