import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ [Supabase] Missing env vars: NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set.");
} else {
  console.log("✅ [Supabase] Env vars loaded. URL:", supabaseUrl);
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

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
