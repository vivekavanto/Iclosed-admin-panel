

import { Resend } from "resend";
import supabaseAdmin from "./supabaseAdmin";
import { createInvitationToken } from "./invitationToken";
import {
  formatLeadTypeLabel,
  buildLeadAddressPartsForEmail,
  renderTransactionPhrase,
} from "./leadEmailAddress";
import {
  renderTemplateSafe,
  escapeHtml,
  type TemplateValue,
} from "./renderEmailTemplate";

/**
 * For each action type, list the template names we'll accept (in priority
 * order). The first active, non-empty match wins. Matching is case-insensitive
 * and uses a contains-check, so any template name like "Activate Account" or
 * "Invite User" w
 * orks without requiring an exact rename in the DB.
 */
type AuthEmailType = "invite" | "recovery" | "login";

const TEMPLATE_NAME_CANDIDATES: Record<AuthEmailType, string[]> = {
  invite: ["Invite User", "Activate", "Activate Account", "Welcome Invite"],
  recovery: ["Reset Password", "Password Reset", "Forgot Password"],
  // "login" is for returning customers who already have a portal account: a
  // "Log into iClosed" email with a login link + a password-reset fallback.
  login: ["Log into iClosed", "Log In", "Login"],
};

const TEMPLATE_KEYWORDS: Record<AuthEmailType, string[]> = {
  invite: ["invite", "activate"],
  recovery: ["reset", "recovery"],
  login: ["log into", "log in", "login"],
};

type TemplateLookupResult =
  | { kind: "active"; template: { name: string; subject: string | null; body: string } }
  | { kind: "inactive"; name: string }
  | { kind: "missing" };

async function findTemplate(type: AuthEmailType): Promise<TemplateLookupResult> {
  const keywords = TEMPLATE_KEYWORDS[type];

  // 1. Try exact-name matches (active only) in priority order.
  for (const name of TEMPLATE_NAME_CANDIDATES[type]) {
    const { data } = await supabaseAdmin
      .from("email_templates")
      .select("name, subject, body")
      .ilike("name", name)
      .eq("is_active", true)
      .maybeSingle();
    if (data?.body) return { kind: "active", template: data };
  }

  // 2. Fallback: scan active templates for any whose name contains the
  // accepted keywords. Catches admin-renamed templates like "Activate your
  // iClosed account".
  const { data: activeAll } = await supabaseAdmin
    .from("email_templates")
    .select("name, subject, body")
    .eq("is_active", true);

  if (activeAll) {
    for (const tmpl of activeAll) {
      const n = (tmpl.name ?? "").toLowerCase();
      if (keywords.some((k) => n.includes(k)) && tmpl.body) {
        return { kind: "active", template: tmpl };
      }
    }
  }

  // 3. No active match. Check whether an INACTIVE matching template exists —
  // that signals the admin intentionally disabled this email type, in which
  // case we skip sending entirely instead of falling back to a default body.
  const { data: anyMatching } = await supabaseAdmin
    .from("email_templates")
    .select("name, is_active")
    .or(
      [
        ...TEMPLATE_NAME_CANDIDATES[type].map((n) => `name.ilike.${n}`),
        ...keywords.map((k) => `name.ilike.%${k}%`),
      ].join(","),
    );

  if (anyMatching && anyMatching.length > 0) {
    const inactiveMatch = anyMatching.find((t) => !t.is_active);
    if (inactiveMatch) return { kind: "inactive", name: inactiveMatch.name };
  }

  return { kind: "missing" };
}

/**
 * Sends an invite or recovery email through Resend with a code-owned
 * activation URL. The URL is backed by the `invitation_tokens` table
 * with a 7-day expiry (see src/lib/invitationToken.ts) and points at
 * the /api/auth/activate handler in this app, which exchanges the
 * token for a fresh Supabase action_link on click so the customer
 * portal's /api/auth/callback flow runs unchanged.
 *
 * Email content is fetched from the `email_templates` table. Supports all
 * variables advertised in the admin Email Templates UI:
 *   {{ user.first_name }} {{ user.last_name }} {{ user.get_full_name }}
 *   {{ user.full_name }} {{ user.email }}
 *   {{ lead_address }} {{ lead.address_line1 }} {{ lead.address_city }}
 *   {{ lead.address_province }} {{ lead.file_number }} {{ lead_type }}
 *   {{ stage_name }} {{ stage_status }} {{ confirmation_url }}
 * plus Supabase-style {{ .ConfirmationURL }} / {{ .UserMetadata.* }}.
 */
export async function sendAuthEmailViaResend(opts: {
  type: AuthEmailType;
  email: string;
  redirectTo: string;
  userData?: Record<string, string>;
  /**
   * Optional explicit template selection. If provided we use this template
   * (subject to is_active checks). If omitted we fall back to the name-based
   * findTemplate() lookup. Used by the manual admin family-send flow so the
   * exact template the admin picked in the modal is honoured even when
   * multiple invite/recovery templates exist.
   */
  templateId?: string;
  /**
   * Optional explicit lead row to use for placeholder rendering. When set we
   * skip the "most-recent lead by email" lookup — important when the same
   * email appears on more than one lead (e.g. a client on a Purchase-only file
   * AND on a separate Purchase & Sale file). Without this the wrong addresses
   * end up in the email body.
   */
  leadId?: string;
}): Promise<{
  success: boolean;
  userId?: string;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
  /**
   * The code-owned activation URL minted for this send (backed by
   * invitation_tokens). Returned so callers like the retainer "activate now"
   * webhook can redirect the user straight into the flow instead of waiting for
   * the email to arrive. Present whenever a token was minted (i.e. not on an
   * early auth/token error).
   */
  actionLink?: string;
}> {
  const { type, email, redirectTo, userData, templateId, leadId } = opts;

  // A "login" email is for an existing portal user: its primary CTA is the
  // plain /login page, but it also carries a password-reset link. Supabase has
  // no "login" link type, so we mint a RECOVERY link/token for the reset fallback
  // ({{ reset_url }}). `type` itself stays "login" for template selection.
  const authLinkType: "invite" | "recovery" = type === "login" ? "recovery" : type;

  // The plain customer-portal /login page (the "Log Into iClosed" button in the
  // login email). Derived from redirectTo's origin so we don't re-read the env.
  let loginUrl = "";
  try {
    loginUrl = `${new URL(redirectTo).origin}/login`;
  } catch {
    loginUrl = "";
  }

  // 1. Generate the Supabase auth link. We DISCARD its action_link — the
  //    URL we send the user is minted by createInvitationToken() below so
  //    we own the 7-day expiry rather than inheriting Supabase's 24h
  //    default. The generateLink() call is still required for its side
  //    effect: creating the auth.users row (invite) or surfacing the user
  //    record (recovery) and attaching user_metadata.
  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type: authLinkType,
      email,
      options: {
        redirectTo,
        ...(userData && type === "invite" ? { data: userData } : {}),
      },
    });

  if (linkError) {
    return { success: false, error: linkError.message };
  }

  const user = linkData?.user;

  // 2. Mint our own URL backed by invitation_tokens (7-day TTL). The
  //    /api/auth/activate handler will exchange this token for a fresh
  //    Supabase action_link on click, preserving the existing
  //    customer-portal /api/auth/callback?next=/set-password flow.
  let actionLink: string;
  try {
    const issued = await createInvitationToken({
      type: authLinkType,
      email,
      redirectTo,
      userData,
    });
    actionLink = issued.url;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to mint invitation token: ${message}`,
    };
  }

  // 2. Derive user info for placeholders
  const firstName = user?.user_metadata?.first_name || userData?.first_name || "";
  const lastName = user?.user_metadata?.last_name || userData?.last_name || "";
  const fullName = `${firstName} ${lastName}`.trim();

  // 3. Look up lead so we can fill in lead.* placeholders. Caller must pass
  //    the explicit lead_id — email-based lookup is unsafe when the same
  //    email appears on multiple leads (e.g. a client on a Purchase-only file
  //    AND on a separate Purchase & Sale file).
  let lead: any = null;
  let dealFileNumber: string | null = null;
  try {
    if (leadId) {
      const { data } = await supabaseAdmin
        .from("leads")
        .select("*")
        .eq("id", leadId)
        .maybeSingle();
      lead = data ?? null;
    }

    if (lead?.id) {
      const { data: deal } = await supabaseAdmin
        .from("deals")
        .select("file_number")
        .eq("lead_id", lead.id)
        .maybeSingle();
      dealFileNumber = deal?.file_number ?? null;
    }
  } catch {
    // Non-blocking — lead/deal lookup is optional context for placeholders
  }

  // Centralized address+type formatting — combines purchase & selling
  // addresses for P&S leads (with a family-sibling fallback when the two
  // sides are split across leads) and preserves proper capitalization.
  const addressParts = await buildLeadAddressPartsForEmail(lead);
  const leadAddress = addressParts.treatAsCombined
    ? [addressParts.purchase, addressParts.selling].filter(Boolean).join(" and ")
    : addressParts.typeIsSaleOnly
      ? (addressParts.selling || addressParts.purchase)
      : addressParts.purchase;
  const fileNumber = dealFileNumber ?? lead?.file_number ?? "";
  const leadType = formatLeadTypeLabel(lead?.lead_type);
  const transactionPhrase = renderTransactionPhrase(addressParts, leadType);
  const sideSuffix = addressParts.treatAsCombined
    ? " (Purchase & Sale)"
    : addressParts.recipientSide === "sale"
      ? " (Sale)"
      : "";

  // 4. Resolve template
  let subject: string;
  let bodyHtml: string;
  let lookup: TemplateLookupResult;

  if (templateId) {
    // Honour the exact template the caller picked. Same is_active semantics as
    // the name-based path: inactive → skip the send (admin's off-switch).
    const { data } = await supabaseAdmin
      .from("email_templates")
      .select("name, subject, body, is_active")
      .eq("id", templateId)
      .maybeSingle();
    if (!data) {
      lookup = { kind: "missing" };
    } else if (!data.is_active) {
      lookup = { kind: "inactive", name: data.name };
    } else if (!data.body) {
      lookup = { kind: "missing" };
    } else {
      lookup = {
        kind: "active",
        template: { name: data.name, subject: data.subject, body: data.body },
      };
    }
  } else {
    lookup = await findTemplate(type);
  }

  // Admin explicitly disabled this auth email type → skip the send entirely
  // (no fallback to default body). User still has a valid auth account; we
  // just don't deliver the notification.
  if (lookup.kind === "inactive") {
    console.log(
      `[Auth Email] Skipped ${type} — template "${lookup.name}" is inactive. email=${email}`,
    );
    return {
      success: true,
      userId: user?.id,
      skipped: true,
      skipReason: `Template "${lookup.name}" is inactive`,
      actionLink,
    };
  }

  const template = lookup.kind === "active" ? lookup.template : null;

  if (template?.body) {
    // ── Render DB template with placeholders ──────────────────────────────
    // Normalized placeholder → value lookup (lowercased, leading dot stripped).
    // One entry per meaning; the single-pass renderer trims + lowercases each
    // token before lookup, so every spacing/case variant the old explicit map
    // listed (user.*, Supabase .ConfirmationURL / .UserMetadata.*, etc.) resolves
    // here. Auth links are handled separately in resolve() so they stay raw.
    const values: Record<string, string> = {
      "user.first_name": firstName,
      "user.last_name": lastName,
      "user.full_name": fullName,
      "user.get_full_name": fullName,
      "user.email": email,
      "usermetadata.first_name": firstName,
      "usermetadata.last_name": lastName,
      "usermetadata.email": email,
      "lead_address": leadAddress,
      "property_address": leadAddress,
      "lead.address_line1": lead?.address_street ?? "",
      "lead.address_city": lead?.address_city ?? "",
      "lead.address_province": lead?.address_province ?? "",
      "lead.file_number": fileNumber,
      "file_number": fileNumber,
      "lead_type": leadType,
      "side_suffix": sideSuffix,
      "stage_name": "",
      "stage_status": "",
    };

    // Auth/login links are system-generated URLs (Supabase action link / the
    // login page), never user data — substitute them RAW so a URL's "&" isn't
    // turned into "&amp;". Same catch-all the old code used (any
    // confirmation/activation/reset/… url|link, optional leading dot). Login is
    // matched first because it is NOT an auth link.
    const LOGIN_LINK_RE = /^login[_\s.]*(url|link)$/i;
    const AUTH_LINK_RE =
      /^\.?(confirmation|activation|activate|action|invite|invitation|reset|recovery|password|verification|verify|button)[_\s.]*(url|link)$/i;

    const resolve = (name: string): TemplateValue | null => {
      const key = name.toLowerCase().replace(/^\.+/, "");
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        return { value: values[key] };
      }
      if (LOGIN_LINK_RE.test(key)) return { value: loginUrl, raw: true };
      if (AUTH_LINK_RE.test(key)) return { value: actionLink, raw: true };
      return null;
    };

    // Pair-up pattern: "{{ lead_type }} of {{ lead_address }}" must render as
    // "Purchase of <P> and Sale of <S>" for combined files, not
    // "Purchase & Sale of <P> and <S>" which collapses the two sides. Support
    // the short property_address alias too.
    const transactionPhrasePattern =
      /\{\{\s*lead_type\s*\}\}\s+of\s+\{\{\s*(?:lead_address|property_address)\s*\}\}/gi;

    let processedBody = template.body
      .replace(transactionPhrasePattern, () => escapeHtml(transactionPhrase))
      .replace(/&#123;|&#x7b;|&lbrace;/gi, "{")
      .replace(/&#125;|&#x7d;|&rbrace;/gi, "}")
      .replace(/&nbsp;/g, " ")
      .replace(/ /g, " ");

    // Single-pass, HTML-escaped substitution (SEC-009): a lead field whose value
    // contains "{{ … }}" or HTML can no longer be re-interpreted or inject markup.
    // Auth/login links stay raw via resolve(). stage_* resolve to "".
    processedBody = renderTemplateSafe(processedBody, resolve, { escape: true });

    // Integrity check — if any {{ ... }} placeholder containing url|link
    // survives we have a bug. Log it so the next failure is one grep away
    // from the cause. The email still goes out; we just record what's wrong.
    const leftover = processedBody.match(/\{\{[^}]*(url|link)[^}]*\}\}/i);
    if (leftover) {
      console.warn(
        `[Auth Email] Unreplaced auth-link placeholder in body: "${leftover[0]}". email=${email} type=${type}`,
      );
    }

    // Subject is plain text — same resolver, but WITHOUT HTML-escaping so entities
    // don't show literally (single-pass reflective-injection safety still applies).
    const decodedSubject = (template.subject || template.name)
      .replace(transactionPhrasePattern, transactionPhrase)
      .replace(/&#123;|&#x7b;|&lbrace;/gi, "{")
      .replace(/&#125;|&#x7d;|&rbrace;/gi, "}");
    subject = renderTemplateSafe(decodedSubject, resolve, { escape: false });

    // No HTML wrapper / logo injection — the DB template owns its layout.
    bodyHtml = processedBody;
  } else {
    // No template configured for this auth email type — skip the send.
    // Hardcoded fallback HTML has been removed; admins must create an
    // "Invite User" / "Reset Password" template in the Email Templates UI
    // (or run the seed migration). WARNING: skipping the invite email
    // means new customers will not receive their activation link and
    // cannot log in until admin re-sends.
    console.log(
      `[Auth Email] Skipped ${type} — no template configured. email=${email}`,
    );
    return {
      success: true,
      userId: user?.id,
      skipped: true,
      skipReason: `No ${type} template configured`,
      actionLink,
    };
  }

  // 5. Send via Resend
  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "Email service not configured (missing RESEND_API_KEY)" };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>";

  const { error: sendError } = await resend.emails.send({
    from: fromEmail,
    replyTo: "testing@iclosed.ca",
    to: [email],
    subject,
    html: bodyHtml,
  });

  if (sendError) {
    return { success: false, error: `Resend send failed: ${sendError.message}` };
  }

  return { success: true, userId: user?.id, actionLink };
}
