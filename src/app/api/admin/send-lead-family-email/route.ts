import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { sendWelcomeEmail } from "@/lib/sendWelcomeEmail";
import { sendAuthEmailViaResend } from "@/lib/sendAuthEmail";
import { formatLeadTypeLabel, buildLeadAddressPartsForEmail } from "@/lib/leadEmailAddress";
import { guardServiceRequest } from "@/lib/verifyServiceSignature";
import { get } from "@vercel/blob";
import { isPrivateBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";
import { EMAIL_REPLY_TO } from "@/lib/emailConfig";

/**
 * POST /api/admin/send-lead-family-email
 *
 * Body: { lead_id: string, template_id?: string }
 *
 * Resolves the "family" of leads (the primary + all co-purchasers / co-sellers
 * linked via parent_lead_id), deduplicates by email, then sends the chosen
 * template to each unique recipient. Auth-style templates (Activate Account,
 * Reset Password, etc.) are routed through sendAuthEmailViaResend() so a real
 * Supabase action_link is generated for each recipient; other templates go
 * through sendWelcomeEmail() with bypassIdempotency=true. Returns a per-
 * recipient breakdown so the UI can show partial-success results.
 */
type RecipientResult = {
  lead_id: string;
  name: string;
  email: string;
  role: "primary" | "co-lead";
  success: boolean;
  template_used?: string;
  email_id?: string;
  skipped?: boolean;
  skip_reason?: string;
  error?: string;
  link_type?: "invite" | "recovery";
};

// Matches any placeholder that looks like it should hold an auth action link:
//   {{ confirmation_url }}, {{ .ConfirmationURL }}, {{ activation_link }},
//   {{ activate_url }}, {{ action_link }}, etc. — with or without spaces,
//   underscores, or leading dot.
const AUTH_URL_PLACEHOLDER_RE =
  /\{\{\s*\.?\s*(confirmation|activation|activate|action|invite|invitation|reset|recovery|password|verification|verify|button)[_\s\.]*(url|link)\s*\}\}/i;

// Manual send needs to mirror the auto-flow that fires when a client signs the
// retainer in the customer portal (iclosed_web). The portal generates a PDF,
// stores it under lead_corporate_docs(doc_type='retainer_agreement'), and emails
// it as an attachment. The admin "Send Email" modal was sending the same
// template text-only, so admins saw the retainer email with no PDF and with
// placeholders (side_label, the HTML property_role_row variant) that
// sendWelcomeEmail's interpolate doesn't cover.
function isRetainerTemplate(name: string | null | undefined): boolean {
  return (name ?? "").toLowerCase().includes("retainer agreement");
}

type RetainerSendResult = {
  success: boolean;
  emailId?: string;
  error?: string;
  pdfCount?: number;
};

// Sends the "Retainer Agreement Signed" template to a single recipient, mirroring
// the customer-portal auto-flow: fetches every signed retainer PDF for the lead,
// renders the template with the same variable map the portal uses, and attaches
// all PDFs in one email. Refuses to send when no signed PDF exists — the admin
// shouldn't be able to deliver a "your retainer is signed" email before the
// client has actually signed.
async function sendRetainerEmail(
  lead: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    lead_type: string | null;
    address_street: string | null;
    address_city: string | null;
    address_province: string | null;
    address_postal_code: string | null;
    selling_address_street: string | null;
    selling_address_city: string | null;
    selling_address_province: string | null;
    selling_address_postal_code: string | null;
    parent_lead_id: string | null;
    co_person_role: string | null;
  },
  template: { name: string | null; subject: string | null; body: string },
  resend: Resend,
  fromEmail: string,
): Promise<RetainerSendResult> {
  if (!lead.email) {
    return { success: false, error: "Recipient has no email address" };
  }

  // 1. Fetch every signed retainer PDF for this lead. For Purchase & Sale leads
  //    there can be two (one per side, tagged via `side`).
  const { data: retainerDocs, error: docsErr } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("file_name, file_url, side")
    .eq("lead_id", lead.id)
    .eq("doc_type", "retainer_agreement");

  if (docsErr) {
    return { success: false, error: `Failed to look up retainer PDF: ${docsErr.message}` };
  }

  // Scope the attachments to the side THIS recipient is party to (recipientSide
  // honors the authoritative co_person_role): a co-purchaser gets the
  // purchase-side retainer, a co-seller the sale-side, and a primary/combined
  // client gets both. NULL-side PDFs are legacy and treated as applying to any
  // side. If side-filtering would leave nothing (mis-tagged data), we fall back
  // to all signed PDFs rather than silently sending none.
  const parts = await buildLeadAddressPartsForEmail(lead);
  const recipientSide = parts.recipientSide;

  let validDocs = (retainerDocs ?? []).filter((d) => !!d.file_url);
  if (recipientSide !== "combined") {
    const scoped = validDocs.filter((d) => {
      const s = (d.side ?? "").toLowerCase().trim();
      return s === recipientSide || s === "";
    });
    if (scoped.length > 0) validDocs = scoped;
  }
  if (validDocs.length === 0) {
    return {
      success: false,
      error: "Retainer agreement is not signed yet — no PDF available to attach",
    };
  }

  // 2. Download each PDF so Resend can carry it as an attachment. Private blobs
  //    (SEC-003) can't be fetched by URL alone, so pull them server-side with a
  //    blob token via get(); public/legacy URLs use a plain fetch as before.
  const attachments: { filename: string; content: Buffer }[] = [];
  for (const doc of validDocs) {
    try {
      let bytes: Buffer;
      if (isPrivateBlobUrl(doc.file_url as string)) {
        const result = await get(doc.file_url as string, {
          access: "private",
          token: blobTokenForUrl(doc.file_url as string),
        });
        if (!result || !result.stream) {
          return {
            success: false,
            error: "Failed to download retainer PDF (private blob not found)",
          };
        }
        bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
      } else {
        const res = await fetch(doc.file_url as string);
        if (!res.ok) {
          return {
            success: false,
            error: `Failed to download retainer PDF (status ${res.status})`,
          };
        }
        bytes = Buffer.from(await res.arrayBuffer());
      }
      attachments.push({
        filename: doc.file_name || "retainer-agreement.pdf",
        content: bytes,
      });
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to download retainer PDF: ${err?.message ?? "unknown error"}`,
      };
    }
  }

  // 3. Compute the variable set the auto-flow uses. We're attaching all PDFs in
  //    one email so side-specific labels stay blank — the template body still
  //    renders cleanly because side_label/side_suffix/property_role_row are all
  //    optional. propertyRoleRow is emitted as an HTML <tr><td> so the retainer
  //    template's signature-block table layout doesn't break.
  const firstName = (lead.first_name ?? "").trim();
  const fullName = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();

  // Transaction label scoped to the side THIS recipient is party to. A co-person
  // on a Purchase & Sale deal retains us for only one side, so a co-purchaser
  // sees "Purchase" and a co-seller "Sale" — not the combined "Purchase & Sale".
  // The primary/combined client keeps the full "Purchase & Sale" label. Mirrors
  // formatLeadTypeLabelForRecipient() in iclosed_web. recipientSide is the
  // authoritative side (honors co_person_role) computed above.
  const baseLeadType = formatLeadTypeLabel(lead.lead_type);
  const isCoPerson = Boolean(lead.parent_lead_id);
  const leadType =
    baseLeadType === "Purchase & Sale" && isCoPerson
      ? recipientSide === "sale"
        ? "Sale"
        : recipientSide === "purchase"
          ? "Purchase"
          : baseLeadType
      : baseLeadType;

  // Address, role and subject suffix scoped to the side this recipient sees
  // (recipientSide already honors co_person_role and backfills the missing
  // side from family siblings). Same parts used to filter the PDFs above:
  //   combined primary → both addresses, "Purchaser & Seller", " (Purchase & Sale)"
  //   co-purchaser / purchaser → purchase only, "" suffix
  //   co-seller / seller → sale only, " (Sale)" suffix
  const propertyAddress = parts.treatAsCombined
    ? [parts.purchase, parts.selling].filter(Boolean).join(" and ")
    : parts.typeIsSaleOnly
      ? (parts.selling || parts.purchase)
      : parts.purchase;

  const role = lead.parent_lead_id
    ? recipientSide === "sale"
      ? "Co-Seller"
      : "Co-Purchaser"
    : recipientSide === "combined"
      ? "Purchaser & Seller"
      : recipientSide === "sale"
        ? "Seller"
        : "Purchaser";

  const sideSuffix = recipientSide === "combined"
    ? " (Purchase & Sale)"
    : recipientSide === "sale"
      ? " (Sale)"
      : "";

  // HTML row matches the format buildRetainerEmailHtml emits in iclosed_web so
  // the retainer template's table layout is preserved.
  const propertyRoleRow = role
    ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: bold; color: #555;">Your Role:</td><td style="padding: 4px 0;">${role}</td></tr>`
    : "";

  // Plain-text version for templates that use the alias outside a table.
  const propertyRolePlain = role ? `Your Role: ${role}` : "";

  const placeholders: Record<string, string> = {
    "{{ first_name }}": firstName || "there",
    "{{first_name}}": firstName || "there",
    "{{ last_name }}": lead.last_name ?? "",
    "{{last_name}}": lead.last_name ?? "",
    "{{ full_name }}": fullName,
    "{{full_name}}": fullName,
    "{{ email }}": lead.email,
    "{{email}}": lead.email,
    "{{ user.first_name }}": firstName || "there",
    "{{user.first_name}}": firstName || "there",
    "{{ user.last_name }}": lead.last_name ?? "",
    "{{user.last_name}}": lead.last_name ?? "",
    "{{ user.full_name }}": fullName,
    "{{user.full_name}}": fullName,
    "{{ user.get_full_name }}": fullName,
    "{{user.get_full_name}}": fullName,
    "{{ user.email }}": lead.email,
    "{{user.email}}": lead.email,
    "{{ property_address }}": propertyAddress || "N/A",
    "{{property_address}}": propertyAddress || "N/A",
    "{{ lead_address }}": propertyAddress || "N/A",
    "{{lead_address}}": propertyAddress || "N/A",
    "{{ lead_type }}": leadType || "N/A",
    "{{lead_type}}": leadType || "N/A",
    "{{ side_label }}": "",
    "{{side_label}}": "",
    "{{ side_suffix }}": sideSuffix,
    "{{side_suffix}}": sideSuffix,
    "{{ property_role_row }}": propertyRoleRow,
    "{{property_role_row}}": propertyRoleRow,
    "{{ property_role }}": propertyRolePlain,
    "{{property_role}}": propertyRolePlain,
  };

  let processedBody = template.body
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/&nbsp;/g, " ")
    .replace(/ /g, " ");
  for (const [key, value] of Object.entries(placeholders)) {
    processedBody = processedBody.replaceAll(key, value);
  }
  // Whitespace-tolerant fallback for any straggler.
  for (const [bare, value] of [
    ["first_name", firstName || "there"],
    ["last_name", lead.last_name ?? ""],
    ["full_name", fullName],
    ["email", lead.email],
    ["user.first_name", firstName || "there"],
    ["user.last_name", lead.last_name ?? ""],
    ["user.full_name", fullName],
    ["user.get_full_name", fullName],
    ["user.email", lead.email],
    ["property_address", propertyAddress || "N/A"],
    ["lead_address", propertyAddress || "N/A"],
    ["lead_type", leadType || "N/A"],
    ["side_label", ""],
    ["side_suffix", sideSuffix],
    ["property_role_row", propertyRoleRow],
    ["property_role", propertyRolePlain],
  ] as const) {
    const escaped = bare.replace(/\./g, "\\.");
    processedBody = processedBody.replace(
      new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, "gi"),
      value,
    );
  }

  const rawSubject =
    template.subject && template.subject.trim() !== ""
      ? template.subject
      : template.name || `Your Signed Retainer Agreement${sideSuffix} — iClosed`;
  let processedSubject = rawSubject
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}");
  for (const [key, value] of Object.entries(placeholders)) {
    processedSubject = processedSubject.replaceAll(key, value);
  }
  processedSubject = processedSubject.replace(
    /\{\{\s*first_name\s*\}\}/gi,
    firstName || "there",
  );
  processedSubject = processedSubject.replace(
    /\{\{\s*side_suffix\s*\}\}/gi,
    sideSuffix,
  );

  const { data: sendResult, error: sendError } = await resend.emails.send({
    from: fromEmail,
    replyTo: EMAIL_REPLY_TO,
    to: [lead.email],
    subject: processedSubject,
    html: processedBody,
    attachments,
  });

  if (sendError) {
    return { success: false, error: sendError.message };
  }

  console.log(
    `[Retainer Email] Sent to ${lead.email} with ${attachments.length} PDF attachment(s), id=${sendResult?.id}`,
  );

  return { success: true, emailId: sendResult?.id, pdfCount: attachments.length };
}

// Classify an email_templates row. We look at both the body and the name so a
// template named "Welcome Email" still routes through the auth path if its
// body contains a {{ confirmation_url }}-style placeholder. Without this the
// placeholder would survive untouched and the rendered <a href> would point
// at the literal text `{{ confirmation_url }}` — which is unclickable.
function detectAuthType(
  templateName: string | null | undefined,
  templateBody: string | null | undefined,
): "invite" | "recovery" | null {
  const name = (templateName ?? "").toLowerCase();
  const body = templateBody ?? "";

  // Name-based recovery detection (highest signal — admin explicitly named it
  // "Reset Password").
  if (
    name.includes("reset") ||
    name.includes("recovery") ||
    name.includes("forgot") ||
    (name.includes("password") && !name.includes("set password"))
  ) {
    return "recovery";
  }

  // Name-based invite detection.
  if (
    name.includes("invite") ||
    name.includes("activate") ||
    name.includes("activation")
  ) {
    return "invite";
  }

  // Body-based fallback: if the template body contains an auth-link
  // placeholder, route through the auth path so the link gets generated.
  // Default to "invite" — sendAuthEmailViaResend's invite path falls back to
  // recovery for existing users via the retry logic below.
  if (AUTH_URL_PLACEHOLDER_RE.test(body)) {
    return "invite";
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const blocked = guardServiceRequest(req, raw, { routeKey: "send-lead-family-email" });
    if (blocked) return blocked;
    const body = JSON.parse(raw);
    const { lead_id, template_id, lead_ids } = body as {
      lead_id?: string;
      template_id?: string;
      lead_ids?: string[];
    };

    if (!lead_id) {
      return NextResponse.json(
        { success: false, error: "lead_id is required" },
        { status: 400 },
      );
    }

    // Optional explicit recipient subset. When provided, we restrict the send
    // to just these family members so the admin can email any single client
    // (or any combination) without forcing the whole family.
    const recipientFilter = Array.isArray(lead_ids)
      ? new Set(lead_ids.filter((id): id is string => typeof id === "string"))
      : null;

    // 1. Fetch the lead the admin clicked on.
    const { data: clicked, error: clickedError } = await supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, email, parent_lead_id")
      .eq("id", lead_id)
      .eq("is_deleted", false)
      .single();

    if (clickedError || !clicked) {
      return NextResponse.json(
        { success: false, error: "Lead not found" },
        { status: 404 },
      );
    }

    // 2. Resolve the primary. If the clicked lead has a parent, fetch the
    //    parent; otherwise the clicked lead is the primary.
    let primary = clicked;
    if (clicked.parent_lead_id) {
      const { data: parent } = await supabaseAdmin
        .from("leads")
        .select("id, first_name, last_name, email, parent_lead_id")
        .eq("id", clicked.parent_lead_id)
        .eq("is_deleted", false)
        .single();
      if (parent) primary = parent;
    }

    // 3. Fetch all co-leads (siblings + clicked-lead if it was a co-lead).
    const { data: coLeads } = await supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, email, parent_lead_id")
      .eq("parent_lead_id", primary.id)
      .eq("is_deleted", false);

    const family: Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      role: "primary" | "co-lead";
    }> = [
      { ...primary, role: "primary" },
      ...((coLeads ?? []).map((l) => ({ ...l, role: "co-lead" as const }))),
    ];

    // 4. Dedupe by lowercased email; drop rows with empty email.
    const seen = new Set<string>();
    let recipients = family.filter((l) => {
      const key = (l.email ?? "").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 4b. If the caller passed an explicit subset, restrict to those IDs.
    //     Every ID must belong to the resolved family — otherwise we'd let a
    //     caller spam arbitrary lead emails through this endpoint.
    if (recipientFilter) {
      const familyIds = new Set(family.map((l) => l.id));
      const unknown = [...recipientFilter].filter((id) => !familyIds.has(id));
      if (unknown.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: `lead_ids contains IDs not in this family: ${unknown.join(", ")}`,
          },
          { status: 400 },
        );
      }
      recipients = recipients.filter((l) => recipientFilter.has(l.id));
    }

    if (recipients.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: recipientFilter
            ? "Selected recipients have no valid email address"
            : "No family member has a valid email address",
          total: 0,
          sent: 0,
          failed: 0,
          results: [],
        },
        { status: 400 },
      );
    }

    // 5. Classify the chosen template so we know whether to use the auth path
    //    (Activate Account / Reset Password), the retainer-PDF path, or the
    //    regular welcome path. We pull body+subject too — body so body-based
    //    detectAuthType can catch templates with confirmation_url placeholders,
    //    and both fields so the retainer handler can render without refetching.
    let authType: "invite" | "recovery" | null = null;
    let templateName: string | null = null;
    let templateRow: { name: string | null; subject: string | null; body: string } | null = null;
    if (template_id) {
      const { data: tmpl } = await supabaseAdmin
        .from("email_templates")
        .select("name, subject, body")
        .eq("id", template_id)
        .maybeSingle();
      templateName = tmpl?.name ?? null;
      authType = detectAuthType(templateName, tmpl?.body);
      if (tmpl?.body) {
        templateRow = {
          name: tmpl.name ?? null,
          subject: tmpl.subject ?? null,
          body: tmpl.body,
        };
      }
    }
    const retainerMode = !authType && isRetainerTemplate(templateName) && !!templateRow;
    console.log(
      `[Family Email] template_id=${template_id ?? "(none)"} name="${templateName ?? "(none)"}" authType=${authType ?? "welcome"} retainer=${retainerMode} recipients=${recipients.length}`,
    );

    // Lazy Resend client — only initialized when the retainer path actually
    // needs it. Skips the env-var requirement for non-retainer sends.
    let resendClient: Resend | null = null;
    const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>";
    if (retainerMode) {
      if (!process.env.RESEND_API_KEY) {
        return NextResponse.json(
          { success: false, error: "Email service not configured (missing RESEND_API_KEY)" },
          { status: 500 },
        );
      }
      resendClient = new Resend(process.env.RESEND_API_KEY);
    }

    // Customer-portal redirect URL — same pattern used by the auto-invite in
    // convertLead.ts so admins and auto-flows land on the same set-password
    // page.
    const customerPortalUrl = (
      process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ??
      "https://iclosed.ca"
    ).replace(/\/+$/, "");
    const redirectTo = `${customerPortalUrl}/api/auth/callback?next=/set-password`;

    // 6. Send sequentially — keeps Resend rate-limit behaviour identical to
    //    today's single-recipient flow and produces deterministic per-recipient
    //    logs.
    const results: RecipientResult[] = [];
    for (const r of recipients) {
      const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "(no name)";

      if (authType) {
        // ── Auth-style template: generate a fresh Supabase action_link ──────
        const userData = {
          first_name: r.first_name ?? "",
          last_name: r.last_name ?? "",
          display_name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
        };

        let effectiveType: "invite" | "recovery" = authType;
        let res = await sendAuthEmailViaResend({
          type: effectiveType,
          email: r.email ?? "",
          redirectTo,
          userData,
          templateId: template_id,
          leadId: r.id,
        });

        // Invite to an email that already has an auth user → Supabase rejects
        // with "User already registered" (or similar). Fall back to a recovery
        // link so the existing user still receives a working button. Regex is
        // intentionally broad — Supabase has changed the error wording across
        // versions ("already registered", "already taken", "already exists").
        if (
          !res.success &&
          effectiveType === "invite" &&
          /already\s*(been\s*)?(registered|taken|exists|in\s*use)|user.*(exists|registered)|duplicate.*(user|email)/i.test(
            res.error ?? "",
          )
        ) {
          effectiveType = "recovery";
          res = await sendAuthEmailViaResend({
            type: effectiveType,
            email: r.email ?? "",
            redirectTo,
            templateId: template_id,
            leadId: r.id,
          });
        }

        results.push({
          lead_id: r.id,
          name,
          email: r.email ?? "",
          role: r.role,
          success: res.success && !res.error,
          template_used: templateName ?? undefined,
          skipped: res.skipped,
          skip_reason: res.skipReason,
          error: res.error,
          link_type: effectiveType,
        });
        continue;
      }

      if (retainerMode && templateRow && resendClient) {
        // ── Retainer template: mirror the iclosed_web auto-flow ─────────────
        // Fetches signed retainer PDFs from lead_corporate_docs and attaches
        // them. If the client hasn't signed yet, this recipient fails with a
        // clear "not signed yet" message — the admin then sees it in the modal.
        const { data: fullLead } = await supabaseAdmin
          .from("leads")
          .select(
            "id, first_name, last_name, email, lead_type, address_street, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code, parent_lead_id, co_person_role",
          )
          .eq("id", r.id)
          .eq("is_deleted", false)
          .single();

        if (!fullLead) {
          results.push({
            lead_id: r.id,
            name,
            email: r.email ?? "",
            role: r.role,
            success: false,
            template_used: templateName ?? undefined,
            error: "Lead record not found",
          });
          continue;
        }

        const res = await sendRetainerEmail(
          fullLead,
          templateRow,
          resendClient,
          fromEmail,
        );

        results.push({
          lead_id: r.id,
          name,
          email: r.email ?? "",
          role: r.role,
          success: res.success && !res.error,
          template_used: templateName ?? undefined,
          email_id: res.emailId,
          error: res.error,
        });
        continue;
      }

      // ── Regular template: existing welcome-style path ────────────────────
      const res = await sendWelcomeEmail(r.id, {
        templateId: template_id,
        source: "manual",
        bypassIdempotency: true,
      });

      results.push({
        lead_id: r.id,
        name,
        email: r.email ?? "",
        role: r.role,
        success: res.success && !res.error,
        template_used: res.templateUsed,
        email_id: res.emailId,
        skipped: res.skipped,
        skip_reason: res.skipReason,
        error: res.error,
      });
    }

    const sent = results.filter((r) => r.success && !r.skipped).length;
    const failed = results.filter((r) => !r.success).length;

    return NextResponse.json({
      success: failed === 0 && sent > 0,
      total: results.length,
      sent,
      failed,
      results,
    });
  } catch (err: any) {
    console.error("POST /api/admin/send-lead-family-email error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Server error" },
      { status: 500 },
    );
  }
}
