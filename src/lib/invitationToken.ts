import { randomBytes } from "crypto";
import supabaseAdmin from "./supabaseAdmin";

const TOKEN_TTL_DAYS = 7;
const TOKEN_BYTES = 48;

// SEC-008: the token is deliberately multi-use to survive email-scanner
// pre-fetches, but not UNLIMITED-use. Refuse it past this many consumptions so a
// leaked token can't be replayed for the full TTL. Kept generous (not 5) because
// several independent scanners can each pre-fetch the same link before a human
// clicks; 10 tolerates that while still bounding abuse.
const MAX_CONSUMPTIONS = 10;

export type InvitationType = "invite" | "recovery" | "retainer_sign";

export type ConsumedInvitation = {
  type: InvitationType;
  email: string;
  redirectTo: string;
  userData: Record<string, string> | null;
};

export type ConsumeResult =
  | { ok: true; data: ConsumedInvitation }
  | {
      ok: false;
      reason: "missing" | "expired" | "exhausted" | "error";
      detail?: string;
    };

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
  /**
   * Admin-app path that consumes the token on click. Defaults to the auth
   * activation handler (/api/auth/activate). Callers can override it when a
   * token type should resolve to a different handler.
   */
  activatePath?: string;
  /**
   * Token lifetime in days. Defaults to 7 (invite/recovery links). The retainer
   * "sign without an account" flow passes a very long value because a client
   * may take weeks to sign — the link should stay valid until they do.
   */
  ttlDays?: number;
}): Promise<{ token: string; url: string }> {
  const { type, email, redirectTo, userData, activatePath, ttlDays } = opts;

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(
    Date.now() + (ttlDays ?? TOKEN_TTL_DAYS) * 24 * 60 * 60 * 1000,
  );

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

  const path = activatePath ?? "/api/auth/activate";
  const url = `${resolveBaseUrl()}${path}?token=${encodeURIComponent(token)}`;
  return { token, url };
}

export async function consumeInvitationToken(token: string): Promise<ConsumeResult> {
  if (!token) return { ok: false, reason: "missing" };

  const { data, error } = await supabaseAdmin
    .from("invitation_tokens")
    .select("type, email, redirect_to, user_data, expires_at, consumption_count")
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
  // safe.
  //
  // SEC-008: multi-use, but not UNLIMITED-use. Once the token has been consumed
  // MAX_CONSUMPTIONS times, refuse it so a leaked token can't be replayed for
  // the whole TTL. The cap is generous enough to absorb scanner pre-fetches.
  const currentCount = data.consumption_count ?? 0;
  if (currentCount >= MAX_CONSUMPTIONS) {
    console.warn(
      `[invitationToken] token exhausted (${currentCount}/${MAX_CONSUMPTIONS} uses). email=${data.email} type=${data.type}`,
    );
    return { ok: false, reason: "exhausted" };
  }

  // Count this consumption; stamp used_at on the FIRST hit only so admins still
  // see when the token was first activated. Best-effort — failures here are
  // non-fatal. Read-then-write is acceptable given the generous cap; a couple of
  // concurrent scanner hits can't meaningfully overshoot it.
  const tokenUpdate: { consumption_count: number; used_at?: string } = {
    consumption_count: currentCount + 1,
  };
  if (currentCount === 0) {
    tokenUpdate.used_at = new Date().toISOString();
  }
  await supabaseAdmin
    .from("invitation_tokens")
    .update(tokenUpdate)
    .eq("token", token);

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
