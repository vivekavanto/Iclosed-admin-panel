import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabase = supabaseAdmin;

// Partners are the referral sources stored in the `partners` table (a partner is
// a Mortgage Broker or Real Estate Agent). Each gets a unique referral_code: a
// name-derived prefix + a GLOBALLY sequential number, so no two codes ever
// share the same number (JANE0001, SARAH0002, JOHN0003…). Numbering globally
// (rather than per-prefix) avoids two different partners both showing "0001".
//
// agent_name is the person and brokerage_name the firm; only agent_name is
// required. Coupons are not read here — the per-partner code is the only
// referral code.
//
// This file is the canonical source of the code-generation scheme. The public
// web app mirrors it when intake find-or-creates a partner for a keyed-in agent
// — keep both in sync: D:\iclosed_dev_web\src\lib\resolvePartner.ts

// True when another non-deleted partner already uses this email (case-
// insensitive). Blank emails are allowed to repeat since email is optional.
// `excludeId` skips the row being edited so a partner can keep its own email.
async function emailTaken(email: string, excludeId?: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const { data } = await supabase
    .from("partners")
    .select("id, agent_email")
    .eq("is_deleted", false);
  return (data ?? []).some(
    (r) => (r.agent_email ?? "").trim().toLowerCase() === normalized && r.id !== excludeId,
  );
}

// Derive the code prefix from the partner's first name (fallback: email
// local-part, fallback: PTNR). Uppercased letters only, capped at 8 chars.
function derivePrefix(name?: string | null, email?: string | null): string {
  const firstToken = (name ?? "").trim().split(/\s+/)[0] ?? "";
  const emailLocal = (email ?? "").split("@")[0] ?? "";
  const source = firstToken || emailLocal || "PTNR";
  const cleaned = source.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  return cleaned || "PTNR";
}

// GET /api/admin/partners — list partners (newest first) + clients_referred count
export async function GET() {
  const { data, error } = await supabase
    .from("partners")
    .select("*")
    .eq("is_deleted", false)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const partners = data ?? [];

  // Attach clients_referred per partner — one query on leads by partner_id.
  const ids = partners.map((p) => p.id);
  const referredCount = new Map<string, number>();
  if (ids.length > 0) {
    const { data: leads } = await supabase
      .from("leads")
      .select("partner_id")
      .in("partner_id", ids);
    for (const l of leads ?? []) {
      if (!l.partner_id) continue;
      referredCount.set(l.partner_id, (referredCount.get(l.partner_id) ?? 0) + 1);
    }
  }

  const withCounts = partners.map((p) => ({
    ...p,
    clients_referred: referredCount.get(p.id) ?? 0,
  }));

  return NextResponse.json(withCounts);
}

// POST /api/admin/partners — create a partner + generate its referral_code
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { agent_name, agent_email, agent_phone, brokerage_type, brokerage_name } = body;

  if (!agent_name || !String(agent_name).trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  if (agent_email && (await emailTaken(String(agent_email)))) {
    return NextResponse.json(
      { error: "A partner with this email already exists." },
      { status: 409 },
    );
  }

  const prefix = derivePrefix(agent_name, agent_email);

  // Scan-max the trailing number across ALL existing codes (any prefix, including
  // soft-deleted partners), so the next code's number is globally unique and a
  // retired partner's number is never reissued. Then insert with retry on the
  // unique index (23505).
  const { data: existing } = await supabase
    .from("partners")
    .select("referral_code");

  let maxNum = 0;
  for (const row of existing ?? []) {
    const m = /(\d+)$/.exec(row.referral_code ?? "");
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  }

  for (let attempt = 1; attempt <= 10; attempt++) {
    const referral_code = `${prefix}${String(maxNum + attempt).padStart(4, "0")}`;
    const { data, error } = await supabase
      .from("partners")
      .insert([
        {
          agent_name: String(agent_name).trim(),
          agent_email: agent_email || null,
          agent_phone: agent_phone || null,
          brokerage_type: brokerage_type || null,
          brokerage_name: brokerage_name || null,
          referral_code,
        },
      ])
      .select("*")
      .single();

    if (!error) {
      return NextResponse.json({ ...data, clients_referred: 0 }, { status: 201 });
    }
    // Unique violation on referral_code — another insert took this number; retry.
    if (error.code === "23505") continue;
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    { error: "Could not generate a unique referral code — please try again." },
    { status: 409 },
  );
}

// PUT /api/admin/partners — update fields (referral_code is stable, never changed)
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, agent_name, agent_email, agent_phone, brokerage_type, brokerage_name } = body;

  if (!id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  if (agent_email && (await emailTaken(String(agent_email), id))) {
    return NextResponse.json(
      { error: "A partner with this email already exists." },
      { status: 409 },
    );
  }

  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (agent_name !== undefined) updateData.agent_name = agent_name;
  if (agent_email !== undefined) updateData.agent_email = agent_email || null;
  if (agent_phone !== undefined) updateData.agent_phone = agent_phone || null;
  if (brokerage_type !== undefined) updateData.brokerage_type = brokerage_type || null;
  if (brokerage_name !== undefined) updateData.brokerage_name = brokerage_name || null;

  const { data, error } = await supabase
    .from("partners")
    .update(updateData)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// DELETE /api/admin/partners?id=... — soft-delete
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  let id = searchParams.get("id");

  if (!id) {
    try {
      const body = await req.json();
      id = body?.id ?? null;
    } catch {
      // no body — fall through
    }
  }

  if (!id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("partners")
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Partner not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, id });
}
