import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import {
  STEP_UP_COOKIE,
  clearStepUpCookie,
  isStepUpTokenValid,
  setStepUpCookie,
  stepUpRememberEnabled,
} from "@/lib/stepUpSession";

// Admin-only impersonation (SEC-006). The acting admin must confirm their own
// password; ticking "don't ask again" remembers that confirmation for the rest
// of their login session (see stepUpSession.ts). Every call records an audit
// row. The customer is NOT notified. Uses supabaseAdmin.auth.admin.generateLink
// to mint the magic link server-side.

/**
 * Forgets a remembered confirmation — called on admin sign-out, and available
 * for a "start asking me again" control. The cookie is httpOnly, so only the
 * server can clear it.
 */
export async function DELETE() {
  return clearStepUpCookie(NextResponse.json({ success: true }));
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      email?: string;
      authUserId?: string;
      stepUpPassword?: string;
      /** "Don't ask me again" — remember this confirmation for this login. */
      rememberStepUp?: boolean;
    };

    // ── SEC-006 step-up: the acting admin must prove their OWN password ──
    // so a merely-open (or hijacked) admin session can't silently take over a
    // customer account.
    //
    // If they ticked "don't ask again", that proof is remembered for the rest
    // of this LOGIN SESSION rather than demanded on every click, so reviewing
    // several client portals in a row doesn't mean retyping the password. A
    // password is still required to grant it, signing out revokes it, and each
    // impersonation is still audited with which of the two it used.
    const actor = await getActingAdmin();
    if (!actor.email) {
      return NextResponse.json(
        { error: "Could not identify the acting admin" },
        { status: 401 },
      );
    }
    const identity = { adminId: actor.id, sessionId: actor.sessionId };

    const cookieStore = await cookies();
    const remembered = isStepUpTokenValid(
      cookieStore.get(STEP_UP_COOKIE)?.value,
      identity,
    );

    if (!remembered) {
      if (!body.stepUpPassword || typeof body.stepUpPassword !== "string") {
        return NextResponse.json(
          {
            error: "Password confirmation required",
            stepUpRequired: true,
            // Whether to show the "don't ask me again" option at all: it needs
            // the feature enabled AND a session id to bind the answer to.
            canRemember: stepUpRememberEnabled() && !!actor.sessionId,
          },
          { status: 401 },
        );
      }
      // Verify the password with a throwaway anon client that never persists
      // a session.
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
        // Distinguish a fresh password check from one riding a remembered
        // confirmation, so the audit trail still shows exactly how each
        // impersonation was authorised.
        step_up: remembered ? "session" : "password",
      },
      req,
    });

    // Remember the confirmation only when the admin asked for it. Without the
    // tick, this stays a per-action check: no cookie is issued and the next
    // impersonation prompts again.
    const res = NextResponse.json({ url, remembered: remembered || !!body.rememberStepUp });
    return !remembered && body.rememberStepUp ? setStepUpCookie(res, identity) : res;
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Unexpected error" },
      { status: 500 }
    );
  }
}
