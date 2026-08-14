import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { normalizeRecipientEmail } from "@/lib/emailIdentity";

// Additional contacts for a referral partner, beyond partners.agent_email (the
// primary, still edited on the partner itself). Everyone here is CC'd on
// "Shared with agent" emails for every file that partner referred — see
// src/lib/agentCc.ts.
//
// Soft-delete only (is_deleted), matching partners. The unique index is partial
// on is_deleted = false, so removing a contact and re-adding the same address
// later works.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/admin/partners/contacts?partner_id=... — list a partner's contacts
export async function GET(req: NextRequest) {
  const partnerId = new URL(req.url).searchParams.get("partner_id");
  if (!partnerId || !isUuid(partnerId)) {
    return NextResponse.json({ error: "Valid partner_id is required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("partner_contacts")
    .select("id, partner_id, name, email, created_at")
    .eq("partner_id", partnerId)
    .eq("is_deleted", false)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

// POST /api/admin/partners/contacts — add a contact { partner_id, email, name? }
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const partnerId = typeof body.partner_id === "string" ? body.partner_id : "";
  if (!isUuid(partnerId)) {
    return NextResponse.json({ error: "Valid partner_id is required" }, { status: 400 });
  }

  const email = normalizeRecipientEmail(
    typeof body.email === "string" ? body.email : "",
  );
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
  }

  const name =
    typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;

  // The partner must exist and be live — otherwise a stale UI could attach
  // contacts to a deleted partner where they'd never be seen again.
  const { data: partner } = await supabaseAdmin
    .from("partners")
    .select("id, agent_email")
    .eq("id", partnerId)
    .eq("is_deleted", false)
    .maybeSingle();
  if (!partner) {
    return NextResponse.json({ error: "Partner not found" }, { status: 404 });
  }

  // The primary agent_email is already CC'd, so adding it again here would only
  // produce a duplicate the send-side dedupe would silently drop. Reject it so
  // the admin understands why it didn't appear in the list.
  if (
    normalizeRecipientEmail(partner.agent_email).toLowerCase() === email.toLowerCase()
  ) {
    return NextResponse.json(
      { error: "That's already the partner's primary email — it is CC'd automatically." },
      { status: 409 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from("partner_contacts")
    .insert([{ partner_id: partnerId, email, name }])
    .select("id, partner_id, name, email, created_at")
    .single();

  if (error) {
    // 23505 = the partial unique index on (partner_id, lower(email)).
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "This email is already a contact for this partner." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

// DELETE /api/admin/partners/contacts?id=... — soft-delete a contact
export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !isUuid(id)) {
    return NextResponse.json({ error: "Valid id is required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("partner_contacts")
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("is_deleted", false)
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, id });
}
