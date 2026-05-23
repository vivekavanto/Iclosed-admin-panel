import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

// Admin-only impersonation. Uses supabaseAdmin.auth.admin.generateLink — a
// server-only SDK call that RETURNS the magic link and does NOT email the
// client. The client never learns admin generated it.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { email?: string; authUserId?: string };
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

    return NextResponse.json({ url });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Unexpected error" },
      { status: 500 }
    );
  }
}
