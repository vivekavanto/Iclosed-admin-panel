import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { isOwner } from "./staffAccess";
export async function getOwner() {
  const jar = await cookies();
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { cookies: { getAll: () => jar.getAll(), setAll: () => {} } });
  const { data: { user }, error } = await sb.auth.getUser();
  return !error && isOwner(user) ? user : null;
}
