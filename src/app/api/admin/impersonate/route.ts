import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";

// Admin-only impersonation. An authenticated admin session is the only thing
// required: src/middleware.ts gates every /api/admin/* route on a valid session
// with app_metadata.role === "admin", and the acting admin is recorded in the
// audit log below.
//
// SEC-006 originally added a password step-up on top of that (re-enter your own
// password on every impersonation). It was removed by business decision — staff
// open client portals constantly and the extra prompt was blocking day-to-day
// work. Accepted trade-off: anyone holding a live admin session (an unlocked
// machine, a stolen session cookie) can now open client portals without knowing
// the admin's password. The audit trail is what remains, so it must stay intact.
//
// The customer is NOT notified. Uses supabaseAdmin.auth.admin.generateLink to
// mint the magic link server-side.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      email?: string;
      authUserId?: string;
    };

    const actor = await getActingAdmin();
    if (!actor.email) {
      return NextResponse.json(
        { error: "Could not identify the acting admin" },
        { status: 401 },
      );
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

    // No customer-facing notification is sent on impersonation (business
    // decision): clients must not be told when staff view their portal.
    // Transparency is covered by the audit trail below instead.

    // SEC-006 / CMP-004: record WHO impersonated WHOM, when, from where. With
    // the password step-up removed this audit row is the ONLY control on
    // impersonation — never make it best-effort or drop fields from it.
    await recordAudit({
      action: "impersonate",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "user",
      resourceId: email,
      metadata: {
        target_email: email,
        auth_user_id: body.authUserId ?? null,
        step_up: false,
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
