import { createHmac, timingSafeEqual } from "crypto";
import type { NextResponse } from "next/server";

/**
 * "Don't ask me again" for sensitive admin actions (SEC-006 step-up, currently:
 * impersonation).
 *
 * The control exists so a merely-open or hijacked admin session can't silently
 * take over customer accounts — whoever acts must be able to produce the
 * admin's PASSWORD, not just their cookie. Demanding it on every single click
 * made reviewing several client portals in a row painful, so admins retyped
 * their password over and over.
 *
 * Compromise: confirm the password ONCE and, if the admin ticks "don't ask
 * again", remember it for the REST OF THIS LOGIN SESSION. The confirmation is a
 * signed, httpOnly cookie bound to:
 *
 *   • the admin's auth user id  — can't be reused under another account, and
 *   • their Supabase session id — so signing out (or the session ending) voids
 *     it, and the next login must confirm again. This is what makes "until my
 *     login expires" literally true rather than a guess at a duration.
 *
 * It is also a browser-session cookie (no Max-Age), so closing the browser
 * drops it, and sign-out clears it explicitly (DELETE /api/admin/impersonate).
 *
 * A hard ceiling still applies (STEP_UP_MAX_HOURS, default 12) so a browser
 * left open for days can't hold elevated rights indefinitely.
 *
 * What this does NOT weaken: a password is still required to open the window,
 * the cookie can't be forged or extended (HMAC), page scripts can't read it
 * (httpOnly), other sites can't send it (SameSite=Lax), and every impersonation
 * is still audited individually, recording whether it used a fresh password or
 * a remembered confirmation.
 *
 * Tunables:
 *   STEP_UP_MAX_HOURS  ceiling in hours (default 12, max 720). 0 disables
 *                      "don't ask again" entirely — always prompt.
 *   STEP_UP_SECRET     HMAC key; falls back to the service-role key, which is
 *                      server-only and always present.
 */

export const STEP_UP_COOKIE = "iclosed_stepup";

const DEFAULT_MAX_HOURS = 12;
const MAX_MAX_HOURS = 720;

function maxHours(): number {
  const raw = Number(process.env.STEP_UP_MAX_HOURS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_HOURS;
  return Math.min(raw, MAX_MAX_HOURS);
}

/** Ceiling in ms. 0 means "don't ask again" is switched off. */
export function stepUpMaxMs(): number {
  return maxHours() * 60 * 60 * 1000;
}

/** True when admins are allowed to skip the prompt at all. */
export function stepUpRememberEnabled(): boolean {
  return stepUpMaxMs() > 0;
}

function secret(): string {
  return (
    process.env.STEP_UP_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  );
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export type StepUpIdentity = {
  adminId: string | null;
  sessionId: string | null;
};

/**
 * Token format: `<adminId>.<sessionId>.<expiresAtMs>.<hmac>`. All three fields
 * are inside the signed payload, so none can be swapped.
 *
 * Requires a sessionId: without it there is nothing to tie the confirmation to
 * a specific login, and it would outlive a sign-out. In that case the caller
 * simply keeps prompting.
 */
export function createStepUpToken(identity: StepUpIdentity): string | null {
  if (!identity.adminId || !identity.sessionId || !stepUpRememberEnabled()) {
    return null;
  }
  const expiresAt = Date.now() + stepUpMaxMs();
  const payload = `${identity.adminId}.${identity.sessionId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * True when `token` is an untampered confirmation for exactly this admin AND
 * this login session, still inside the ceiling.
 */
export function isStepUpTokenValid(
  token: string | undefined,
  identity: StepUpIdentity,
): boolean {
  if (!token || !identity.adminId || !identity.sessionId) return false;
  if (!secret() || !stepUpRememberEnabled()) return false;

  const parts = token.split(".");
  if (parts.length !== 4) return false;
  const [adminId, sessionId, expiresRaw, provided] = parts;

  if (adminId !== identity.adminId) return false;
  // The session id is the whole point: a new login mints a new one, so an old
  // confirmation stops working the moment the admin signs out and back in.
  if (sessionId !== identity.sessionId) return false;

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expected = sign(`${adminId}.${sessionId}.${expiresRaw}`);
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Attaches the confirmation cookie to a response. No Max-Age, so the browser
 * drops it when it closes; the signed expiry inside enforces the ceiling.
 * No-op when the feature is off or there's no session to bind to.
 */
export function setStepUpCookie(
  res: NextResponse,
  identity: StepUpIdentity,
): NextResponse {
  const token = createStepUpToken(identity);
  if (!token) return res;
  res.cookies.set({
    name: STEP_UP_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return res;
}

/** Clears the confirmation (sign-out, or an admin turning it back on). */
export function clearStepUpCookie(res: NextResponse): NextResponse {
  res.cookies.set({
    name: STEP_UP_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
