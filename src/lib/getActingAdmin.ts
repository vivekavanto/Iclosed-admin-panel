import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Resolves the currently authenticated admin from the session cookie, for audit
// logging (SEC-006 / CMP-004). The route is already gated by src/middleware.ts,
// so this just re-reads who that admin is. Returns nulls if it can't resolve —
// auditing is best-effort and must never block the operation.
export async function getActingAdmin(): Promise<{
  email: string | null;
  id: string | null;
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
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return { email: user?.email ?? null, id: user?.id ?? null };
  } catch {
    return { email: null, id: null };
  }
}
