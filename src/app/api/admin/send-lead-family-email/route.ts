import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { sendWelcomeEmail } from "@/lib/sendWelcomeEmail";
import { sendAuthEmailViaResend } from "@/lib/sendAuthEmail";

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
    const body = await req.json();
    const { lead_id, template_id } = body as {
      lead_id?: string;
      template_id?: string;
    };

    if (!lead_id) {
      return NextResponse.json(
        { success: false, error: "lead_id is required" },
        { status: 400 },
      );
    }

    // 1. Fetch the lead the admin clicked on.
    const { data: clicked, error: clickedError } = await supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, email, parent_lead_id")
      .eq("id", lead_id)
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
        .single();
      if (parent) primary = parent;
    }

    // 3. Fetch all co-leads (siblings + clicked-lead if it was a co-lead).
    const { data: coLeads } = await supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, email, parent_lead_id")
      .eq("parent_lead_id", primary.id);

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
    const recipients = family.filter((l) => {
      const key = (l.email ?? "").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (recipients.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No family member has a valid email address",
          total: 0,
          sent: 0,
          failed: 0,
          results: [],
        },
        { status: 400 },
      );
    }

    // 5. Classify the chosen template so we know whether to use the auth path
    //    (Activate Account / Reset Password) or the regular welcome path. We
    //    pull the body too so body-based detection can catch templates whose
    //    name doesn't hint at an auth flow but whose body contains a
    //    confirmation_url placeholder.
    let authType: "invite" | "recovery" | null = null;
    let templateName: string | null = null;
    if (template_id) {
      const { data: tmpl } = await supabaseAdmin
        .from("email_templates")
        .select("name, body")
        .eq("id", template_id)
        .maybeSingle();
      templateName = tmpl?.name ?? null;
      authType = detectAuthType(templateName, tmpl?.body);
    }
    console.log(
      `[Family Email] template_id=${template_id ?? "(none)"} name="${templateName ?? "(none)"}" authType=${authType ?? "welcome"} recipients=${recipients.length}`,
    );

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
