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
  | { ok: false; reason: "missing" | "expired" | "error"; detail?: string };

function resolveBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_ADMIN_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  // Why this default instead of localhost: emails sent from local dev still
  // need to embed a publicly-clickable URL or recipients land on a dead host.
  // The hardcoded production admin URL is safe because it always resolves to
  // a deployment that has /api/auth/activate. VERCEL_URL is intentionally
  // skipped — it returns the deployment-specific URL (e.g. -abc123.vercel.app)
  // which expires when a new deployment supersedes it; not stable for 7-day
  // links.
  return "https://iclosed-admin-panel.vercel.app";
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
    .select("type, email, redirect_to, user_data, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (error) return { ok: false, reason: "error", detail: error.message };
  if (!data) return { ok: false, reason: "missing" };
  if (new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  // Why we don't enforce single-use here: email scanners (Outlook SafeLinks,
  // Gmail, Slack/WhatsApp previews, corporate gateways) pre-fetch the link
  // before the human ever clicks it, which used to trip the used_at check
  // and bounce real customers to /login?reason=link_expired&detail=used. The
  // Supabase action_link minted per click below is itself one-time-use and
  // short-lived, so re-using the wrapper token within the 7-day window is
  // safe. We still stamp used_at on first hit (best-effort, no .is() guard
  // needed — overwriting later hits is fine) so admins can see when a token
  // was first activated; failures here are non-fatal.
  await supabaseAdmin
    .from("invitation_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("token", token)
    .is("used_at", null);

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
