import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function POST(req: Request) {
  try {
    const { newEmail, currentPassword } = (await req.json()) as {
      newEmail?: string;
      currentPassword?: string;
    };

    if (!newEmail || !currentPassword) {
      return NextResponse.json(
        { success: false, error: "Missing newEmail or currentPassword." },
        { status: 400 },
      );
    }

    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return NextResponse.json(
        { success: false, error: "Not authenticated." },
        { status: 401 },
      );
    }

    // Identify the caller from their access token.
    const caller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData?.user?.email) {
      return NextResponse.json(
        { success: false, error: "Could not verify session." },
        { status: 401 },
      );
    }
    const currentEmail = userData.user.email;
    const userId = userData.user.id;

    // Only allow admins to use this endpoint.
    const role =
      (userData.user.app_metadata as { role?: string } | null | undefined)?.role ?? null;
    if (role !== "admin") {
      return NextResponse.json(
        { success: false, error: "Admin role required." },
        { status: 403 },
      );
    }

    // Re-verify the current password before changing anything.
    const verify = await caller.auth.signInWithPassword({
      email: currentEmail,
      password: currentPassword,
    });
    if (verify.error) {
      return NextResponse.json(
        { success: false, error: "Current password is incorrect." },
        { status: 401 },
      );
    }

    const trimmed = newEmail.trim().toLowerCase();
    if (trimmed === currentEmail.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "New email must be different from current email." },
        { status: 400 },
      );
    }

    // Service-role update bypasses the user-facing confirmation link.
    // email_confirm: true marks the new email as verified immediately.
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      email: trimmed,
      email_confirm: true,
    });
    if (updateError) {
      return NextResponse.json(
        { success: false, error: updateError.message },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, email: trimmed });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Server error",
      },
      { status: 500 },
    );
  }
}
