/**
 * One-shot migration script — creates the intake tables in Supabase.
 * Run with:  node scripts/migrate-intake.mjs
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://kcrexonvmtzqeuyppegk.supabase.co";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SQL_INTAKES = `
CREATE TABLE IF NOT EXISTS intakes (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Step 1: Service
  service                VARCHAR(20) NOT NULL CHECK (service IN ('closing', 'refinance', 'condo')),

  -- Step 2: Sub-service
  sub_service            VARCHAR(10) CHECK (sub_service IN ('buying', 'selling', 'both')),

  -- Step 3: Client type
  client_type            VARCHAR(15) NOT NULL CHECK (client_type IN ('residential', 'corporate')),
  corporate_name         VARCHAR(255),
  corporate_email        VARCHAR(255),
  corporate_inc_number   VARCHAR(100),
  corporate_jurisdiction VARCHAR(100),

  -- Step 4: Price
  purchase_price         VARCHAR(50),

  -- Step 5: Address
  address_street         VARCHAR(255),
  address_unit           VARCHAR(50),
  address_city           VARCHAR(100),
  address_postal_code    VARCHAR(20),
  address_province       VARCHAR(50) DEFAULT 'Ontario',

  -- Step 6: APS
  aps_signed             BOOLEAN,

  -- Step 7: Contact
  contact_full_name      VARCHAR(255),
  contact_email          VARCHAR(255),
  contact_phone          VARCHAR(50),

  -- Metadata
  status                 VARCHAR(20) DEFAULT 'pending'
                           CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);
`;

const SQL_DOCUMENTS = `
CREATE TABLE IF NOT EXISTS intake_documents (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  intake_id       UUID NOT NULL REFERENCES intakes(id) ON DELETE CASCADE,

  -- 'aps' = Agreement of Purchase and Sale upload
  -- 'corporate' = corporate doc uploads
  doc_category    VARCHAR(20) NOT NULL CHECK (doc_category IN ('aps', 'corporate')),

  doc_type        VARCHAR(100) NOT NULL,
  custom_type     VARCHAR(100),
  file_path       TEXT,
  file_name       VARCHAR(255),
  file_size_bytes BIGINT,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);
`;

async function run() {
  console.log("Running intake migration...\n");

  // Try via RPC exec_sql (works if the function exists in the project)
  for (const [name, sql] of [
    ["intakes", SQL_INTAKES],
    ["intake_documents", SQL_DOCUMENTS],
  ]) {
    const { error } = await supabase.rpc("exec_sql", { sql });

    if (error) {
      // exec_sql doesn't exist — fall back to fetch against the REST endpoint
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/exec_sql`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({ sql }),
        }
      );

      if (!res.ok) {
        const body = await res.text();
        console.error(`❌ Failed to create table "${name}"`);
        console.error(`   Status ${res.status}: ${body}`);
        console.error(
          `\n   → The project doesn't expose exec_sql. Paste the SQL below into the Supabase SQL editor manually:\n`
        );
        console.log("-- intakes --");
        console.log(SQL_INTAKES);
        console.log("-- intake_documents --");
        console.log(SQL_DOCUMENTS);
        process.exit(1);
      }
    }

    console.log(`✅ Table "${name}" ready.`);
  }

  console.log("\nMigration complete.");
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
