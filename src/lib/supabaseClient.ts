import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!


if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ [Supabase] Missing env vars: NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set.");
} else {
  console.log("✅ [Supabase] Env vars loaded. URL:", supabaseUrl);
}

// Cookie-backed browser client. Storing the session in cookies (rather than
// localStorage) is what lets the server-side middleware read it to guard the
// /api/admin/* routes and /admin/* pages — the admin API is service-role and
// has no per-route auth of its own, so the middleware is the gate. The export
// name `supabase` is unchanged so every existing import keeps working.
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey)

export async function testSupabaseConnection() {
  const { data, error } = await supabase.auth.getSession()

  if (error) {
    return {
      connected: false,
      message: "Connection failed",
      error: error.message,
    }
  }

  return {
    connected: true,
    message: "Supabase connection OK",
  }
}
