import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { canAccessOperations } from "./access";

export async function staffAuthClient() {
  const jar = await cookies();
  const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: entries => {
        try { entries.forEach(c => jar.set(c.name, c.value, c.options)); }
        catch { /* Middleware refreshes cookies for Server Components. */ }
      },
    },
  });
  return client;
}
export async function getStaff() {
  const client = await staffAuthClient();
  const { data: { user }, error } = await client.auth.getUser();
  return !error && canAccessOperations(user) ? user : null;
}
