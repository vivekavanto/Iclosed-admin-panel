import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { logger } from "@/lib/logger";

// Admin-only impersonation (SEC-006). Requires the acting admin to re-confirm
// their password (step-up), records an audit row, and notifies the customer
// that their account was accessed. Uses supabaseAdmin.auth.admin.generateLink to
// mint the magic link server-side.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      email?: string;
      authUserId?: string;
      stepUpPassword?: string;
    };

    // ── SEC-006 step-up: the acting admin must re-enter their OWN password ──
    // so a merely-open (or hijacked) admin session can't silently take over a
    // customer account. We verify the password with a throwaway anon client
    // that never persists a session.
    const actor = await getActingAdmin();
    if (!actor.email) {
      return NextResponse.json(
        { error: "Could not identify the acting admin" },
        { status: 401 },
      );
    }
    if (!body.stepUpPassword || typeof body.stepUpPassword !== "string") {
      return NextResponse.json(
        { error: "Password confirmation required", stepUpRequired: true },
        { status: 401 },
      );
    }
    const verifier = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { error: pwErr } = await verifier.auth.signInWithPassword({
      email: actor.email,
      password: body.stepUpPassword,
    });
    if (pwErr) {
      return NextResponse.json({ error: "Password is incorrect" }, { status: 401 });
    }

    let email = body.email;

    if (!email && body.authUserId) {
      const { data: userData, error: userErr } =
        await supabaseAdmin.auth.admin.getUserById(body.authUserId);
      if (userErr || !userData?.user?.email) {
        return NextResponse.json(
          { error: userErr?.message ?? "Could not resolve user email" },
          { status: 400 }
        );
      }
      email = userData.user.email;
    }

    if (!email || typeof email !== "string") {
      return NextResponse.json(
        { error: "Email or authUserId is required" },
        { status: 400 }
      );
    }

    // Magic link must land on the customer portal's auth callback route so
    // it exchanges the `?code=...` for a new session — landing on the bare
    // root skipped that step and left whatever previous impersonated session
    // active, so clicking impersonate on a second deal kept showing the
    // first client's portal.
    const portalBase = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "").replace(/\/+$/, "");
    const redirectTo = portalBase ? `${portalBase}/api/auth/callback` : undefined;

    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: redirectTo ? { redirectTo } : undefined,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const url = data?.properties?.action_link;
    if (!url) {
      return NextResponse.json(
        { error: "Could not generate link" },
        { status: 500 }
      );
    }

    // SEC-006: notify the customer that their account was accessed, for
    // transparency. Best-effort — a send failure must not block the admin.
    // Set IMPERSONATE_NOTIFY_CUSTOMER=false to turn this off.
    if (
      process.env.IMPERSONATE_NOTIFY_CUSTOMER !== "false" &&
      process.env.RESEND_API_KEY
    ) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>",
          to: [email],
          subject: "Your iClosed account was accessed by our team",
          html: `<p>Hello,</p><p>A member of the iClosed team securely accessed your account to help with your file. If this wasn't expected, please reply to this email and let us know.</p><p>— iClosed</p>`,
        });
      } catch (notifyErr) {
        logger.error("[impersonate] customer notification failed:", notifyErr);
      }
    }

    // SEC-006 / CMP-004: record WHO impersonated WHOM, when, from where.
    await recordAudit({
      action: "impersonate",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "user",
      resourceId: email,
      metadata: {
        target_email: email,
        auth_user_id: body.authUserId ?? null,
        step_up: true,
      },
      req,
    });

    return NextResponse.json({ url });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Unexpected error" },
      { status: 500 }
    );
  }
}
