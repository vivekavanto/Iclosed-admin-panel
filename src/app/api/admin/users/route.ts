import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { sendAuthEmailViaResend } from "@/lib/sendAuthEmail";

// Staff / admin registry API.
//
// This route is gated by src/middleware.ts (cookie-backed Supabase session +
// app_metadata.role === "admin"), so only signed-in admins reach it.
//
// public.admin_users is the human-readable ADMIN/STAFF REGISTRY (customers live
// in public.clients). auth.users remains the source of truth for login
// (passwords/sessions) and app_metadata.role === "admin" remains the access
// gate — this route keeps the two in sync but does NOT change how the existing
// login flow works.

const VALID_ROLES = ["Admin", "Clerk", "Lawyer"] as const;
type StaffRole = (typeof VALID_ROLES)[number];

const SELECT_COLS =
  "id, staff_code, name, email, role, phone, title, is_active, last_login_at, deactivated_at, created_by, avatar_url, created_at, updated_at";

function isValidRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (VALID_ROLES as readonly string[]).includes(value);
}

// Identify the signed-in admin making the request (for created_by audit).
async function getCallerId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const sb = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } },
    );
    const { data } = await sb.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

// ── GET: list all staff ──────────────────────────────────────────────────────
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select(SELECT_COLS)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  const users = data ?? [];

  // Best-effort: refresh last_login_at from auth's last_sign_in_at. Bounded by
  // the (small) number of staff, read-only on auth, and never fails the list.
  await Promise.all(
    users.map(async (u) => {
      try {
        const { data: authData } = await supabaseAdmin.auth.admin.getUserById(u.id);
        const lastSignIn = authData?.user?.last_sign_in_at ?? null;
        if (lastSignIn && lastSignIn !== u.last_login_at) {
          u.last_login_at = lastSignIn;
          await supabaseAdmin.from("admin_users").update({ last_login_at: lastSignIn }).eq("id", u.id);
        }
      } catch {
        // ignore — keep the stored value
      }
    }),
  );

  return NextResponse.json({ success: true, users });
}

// ── POST: invite a new staff member ──────────────────────────────────────────
// Creates the Supabase auth account (so they can log in), grants admin access
// (app_metadata.role = "admin" — same gate as today), sends the existing invite
// email, and records the person in the registry.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      email?: string;
      name?: string;
      role?: string;
      phone?: string;
      title?: string;
    };

    const email = body.email?.trim().toLowerCase() ?? "";
    const name = body.name?.trim() ?? "";
    const role = body.role ?? "Clerk";
    const phone = body.phone?.trim() || null;
    const title = body.title?.trim() || null;

    if (!email || !name) {
      return NextResponse.json(
        { success: false, error: "Email and name are required." },
        { status: 400 },
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { success: false, error: "Please enter a valid email address." },
        { status: 400 },
      );
    }
    if (!isValidRole(role)) {
      return NextResponse.json(
        { success: false, error: "Role must be Admin, Clerk, or Lawyer." },
        { status: 400 },
      );
    }

    // Reject if this email is already in the registry.
    const { data: existing } = await supabaseAdmin
      .from("admin_users")
      .select("id")
      .ilike("email", email)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { success: false, error: "A staff member with this email already exists." },
        { status: 409 },
      );
    }

    const callerId = await getCallerId();

    // Reuse the existing invite-email flow. This creates the auth.users row as
    // a side effect and returns its id. The email may be "skipped" if no invite
    // template is configured — the account is still created either way.
    const customerPortalUrl = (
      process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://www.iclosed.ca/"
    ).replace(/\/+$/, "");
    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(" ");

    const invite = await sendAuthEmailViaResend({
      type: "invite",
      email,
      redirectTo: `${customerPortalUrl}/api/auth/callback?next=/set-password`,
      userData: {
        first_name: firstName ?? "",
        last_name: lastName ?? "",
        display_name: name,
      },
    });

    if (!invite.success || !invite.userId) {
      return NextResponse.json(
        {
          success: false,
          error:
            invite.error ??
            "Could not create the login account for this staff member.",
        },
        { status: 400 },
      );
    }

    const userId = invite.userId;

    // Grant admin access using the SAME gate the portal already enforces.
    const { error: roleErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      app_metadata: { role: "admin" },
    });
    if (roleErr) {
      return NextResponse.json(
        { success: false, error: `Account created but granting access failed: ${roleErr.message}` },
        { status: 500 },
      );
    }

    // Record in the registry.
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from("admin_users")
      .insert({ id: userId, email, name, role, phone, title, is_active: true, created_by: callerId })
      .select(SELECT_COLS)
      .single();
    if (insertErr) {
      return NextResponse.json(
        { success: false, error: `Account created but saving to registry failed: ${insertErr.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      user: inserted,
      emailSent: !invite.skipped,
      emailSkippedReason: invite.skipped ? invite.skipReason : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Server error" },
      { status: 500 },
    );
  }
}

// ── PATCH: update a staff member (edit details or activate/deactivate) ────────
export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      id?: string;
      name?: string;
      role?: string;
      phone?: string | null;
      title?: string | null;
      is_active?: boolean;
    };

    const id = body.id?.trim();
    if (!id) {
      return NextResponse.json(
        { success: false, error: "Staff id is required." },
        { status: 400 },
      );
    }

    const updates: Record<string, unknown> = {};
    if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      if (!trimmed) {
        return NextResponse.json(
          { success: false, error: "Name cannot be empty." },
          { status: 400 },
        );
      }
      updates.name = trimmed;
    }
    if (body.role !== undefined) {
      if (!isValidRole(body.role)) {
        return NextResponse.json(
          { success: false, error: "Role must be Admin, Clerk, or Lawyer." },
          { status: 400 },
        );
      }
      updates.role = body.role;
    }
    if (body.phone !== undefined) {
      updates.phone = body.phone?.trim() || null;
    }
    if (body.title !== undefined) {
      updates.title = body.title?.trim() || null;
    }
    if (typeof body.is_active === "boolean") {
      updates.is_active = body.is_active;
      // Stamp deactivation time for offboarding history; clear it on reactivate.
      updates.deactivated_at = body.is_active ? null : new Date().toISOString();
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { success: false, error: "Nothing to update." },
        { status: 400 },
      );
    }

    // When (de)activating, flip portal access via the SAME gate the portal
    // uses. Deactivate → remove the "admin" role so the existing login gate
    // (middleware + AuthProvider) rejects them. The auth account and registry
    // row are preserved, so the record/history stays intact. Reactivate →
    // restore "admin".
    if (typeof body.is_active === "boolean") {
      const { error: accessErr } = await supabaseAdmin.auth.admin.updateUserById(id, {
        app_metadata: { role: body.is_active ? "admin" : "inactive" },
      });
      if (accessErr) {
        return NextResponse.json(
          { success: false, error: `Updating portal access failed: ${accessErr.message}` },
          { status: 500 },
        );
      }
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("admin_users")
      .update(updates)
      .eq("id", id)
      .select(SELECT_COLS)
      .single();
    if (updateErr) {
      return NextResponse.json(
        { success: false, error: updateErr.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, user: updated });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Server error" },
      { status: 500 },
    );
  }
}
