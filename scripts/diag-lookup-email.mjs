// READ-ONLY lookup for one email across clients + leads on the LIVE/prod DB.
import { createClient } from "@supabase/supabase-js";
const SUPABASE_URL = "https://kcrexonvmtzqeuyppegk.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY";
const sb = createClient(SUPABASE_URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const EMAIL = "mselvakone@gmail.com";

const { data: clients } = await sb.from("clients")
  .select("id, email, first_name, last_name, phone, converted, created_at")
  .ilike("email", EMAIL);
console.log("\n=== clients rows for", EMAIL, "===");
console.log(JSON.stringify(clients, null, 2));

const { data: leads } = await sb.from("leads")
  .select("id, email, first_name, last_name, co_person_role, parent_lead_id, is_deleted, status")
  .ilike("email", EMAIL);
console.log("\n=== leads rows for", EMAIL, "===");
console.log(JSON.stringify(leads, null, 2));
console.log("\nDone (read-only).\n");
