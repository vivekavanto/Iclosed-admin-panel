import { randomBytes } from "crypto";
import supabaseAdmin from "./supabaseAdmin";

const TOKEN_TTL_DAYS = 7;
const TOKEN_BYTES = 48;

export type InvitationType = "invite" | "recovery";

export type ConsumedInvitation = {
  type: InvitationType;
  email: string;
  redirectTo: string;
  userData: Record<string, string> | null;
};

export type ConsumeResult =
  | { ok: true; data: ConsumedInvitation }
  | { ok: false; reason: "missing" | "expired" | "used" | "error"; detail?: string };

function resolveBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_ADMIN_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export async function createInvitationToken(opts: {
  type: InvitationType;
  email: string;
  redirectTo: string;
  userData?: Record<string, string>;
}): Promise<{ token: string; url: string }> {
  const { type, email, redirectTo, userData } = opts;

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const { error } = await supabaseAdmin.from("invitation_tokens").insert({
    token,
    email,
    type,
    redirect_to: redirectTo,
    user_data: userData ?? null,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    throw new Error(`Failed to persist invitation token: ${error.message}`);
  }

  const url = `${resolveBaseUrl()}/api/auth/activate?token=${encodeURIComponent(token)}`;
  return { token, url };
}

export async function consumeInvitationToken(token: string): Promise<ConsumeResult> {
  if (!token) return { ok: false, reason: "missing" };

  const { data, error } = await supabaseAdmin
    .from("invitation_tokens")
    .select("type, email, redirect_to, user_data, expires_at, used_at")
    .eq("token", token)
    .maybeSingle();

  if (error) return { ok: false, reason: "error", detail: error.message };
  if (!data) return { ok: false, reason: "missing" };
  if (data.used_at) return { ok: false, reason: "used" };
  if (new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const { error: updateError } = await supabaseAdmin
    .from("invitation_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("token", token)
    .is("used_at", null);

  if (updateError) {
    return { ok: false, reason: "error", detail: updateError.message };
  }

  return {
    ok: true,
    data: {
      type: data.type as InvitationType,
      email: data.email,
      redirectTo: data.redirect_to,
      userData: (data.user_data as Record<string, string> | null) ?? null,
    },
  };
}
