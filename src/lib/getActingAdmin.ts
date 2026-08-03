import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Resolves the currently authenticated admin from the session cookie, for audit
// logging (SEC-006 / CMP-004). The route is already gated by src/middleware.ts,
// so this just re-reads who that admin is. Returns nulls if it can't resolve —
// auditing is best-effort and must never block the operation.
export async function getActingAdmin(): Promise<{
  email: string | null;
  id: string | null;
  /**
   * Supabase session id (the `session_id` claim on the access token), i.e. THIS
   * login rather than this user. Used to tie a step-up confirmation to the
   * current login session so it dies when the admin signs out or the session
   * ends. Null when the claim isn't present.
   */
  sessionId: string | null;
}> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          // Read-only: this helper never rotates the session.
          setAll() {},
        },
      },
    );
    // getUser() is the authoritative identity check — it validates the token
    // with the auth server. getSession() only reads the cookie, which is fine
    // for pulling the session id back OUT of the token we just validated.
    const {
      data: { user },
    } = await supabase.auth.getUser();

    let sessionId: string | null = null;
    if (user) {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      sessionId = readSessionId(session?.access_token);
    }

    return { email: user?.email ?? null, id: user?.id ?? null, sessionId };
  } catch {
    return { email: null, id: null, sessionId: null };
  }
}

/** Pulls the `session_id` claim out of a Supabase access token (a JWT). */
function readSessionId(accessToken: string | undefined): string | null {
  if (!accessToken) return null;
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload, "base64").toString("utf8"),
    ) as { session_id?: string };
    return json.session_id ?? null;
  } catch {
    return null;
  }
}
