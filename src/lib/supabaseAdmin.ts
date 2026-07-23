import { createClient } from "@supabase/supabase-js";

// SEC-020: this module holds the Supabase SERVICE-ROLE client, which bypasses
// Row-Level Security. It must never be bundled into or run in the browser. If a
// client component ever imports it (directly or transitively), this throws the
// moment the module is evaluated in the browser, turning a silent leak into a
// loud, obvious failure. (The service-role key itself is a non-NEXT_PUBLIC_ env
// var, so Next already keeps it out of client bundles — this guards the usage.)
// If you'd prefer a build-time failure instead, run `pnpm add server-only` and
// replace this block with `import "server-only";`.
if (typeof window !== "undefined") {
  throw new Error(
    "supabaseAdmin (service-role) was imported into client code — it must only be used on the server.",
  );
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;


const supabaseAdmin = createClient(
  supabaseUrl,
  serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

export default supabaseAdmin;