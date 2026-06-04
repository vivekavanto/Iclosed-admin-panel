import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { convertSingleLead } from "@/lib/convertLead";

/**
 * POST /api/admin/deals/[id]/co-clients
 *
 * Admin-only entry point for adding a co-purchaser / co-seller to an existing
 * deal. This mirrors exactly what the customer portal intake does for a co-
 * person — it creates a CHILD lead (parent_lead_id → the family's root lead,
 * co_person_role = purchaser|seller) and then runs the *existing*
 * `convertSingleLead` flow on it. That single reuse gives us, for free and
 * unchanged:
 *   - the co-lead listed under its primary in "People Involved"
 *     (family resolution in GET /api/admin/deals/[id])
 *   - the invite + welcome emails (sendAuthEmailViaResend + sendWelcomeEmail)
 *   - completed shared tasks synced from the rest of the family
 *   - its own identification task, which powers the per-person ID upload card
 *
 * No existing conversion / email / task logic is touched — we only feed a new
 * lead row into it.
 *
 * Body:
 *   {
 *     role: "purchaser" | "seller",
 *     first_name: string,
 *     last_name: string,
 *     email: string,
 *     phone?: string,
 *   }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const role = String(body.role ?? "").toLowerCase().trim();
  const firstName = String(body.first_name ?? "").trim();
  const lastName = String(body.last_name ?? "").trim();
  const email = String(body.email ?? "").trim();
  const phone = body.phone ? String(body.phone).trim() : null;

  if (role !== "purchaser" && role !== "seller") {
    return NextResponse.json(
      { success: false, error: "role must be 'purchaser' or 'seller'" },
      { status: 400 },
    );
  }
  if (!firstName || !lastName) {
    return NextResponse.json(
      { success: false, error: "First and last name are required" },
      { status: 400 },
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { success: false, error: "A valid email address is required" },
      { status: 400 },
    );
  }

  // ── Resolve the deal → its lead → the family's ROOT lead ──────────────────
  const { data: deal, error: dealError } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, type")
    .eq("id", id)
    .single();

  if (dealError || !deal || !deal.lead_id) {
    return NextResponse.json(
      { success: false, error: "Deal not found" },
      { status: 404 },
    );
  }

  const { data: thisLead, error: thisLeadError } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", deal.lead_id)
    .single();

  if (thisLeadError || !thisLead) {
    return NextResponse.json(
      { success: false, error: "Linked lead not found" },
      { status: 404 },
    );
  }

  // Co-clients always attach to the root of the family, even if the admin
  // happens to be viewing a co-lead's deal.
  const rootLeadId = thisLead.parent_lead_id ?? thisLead.id;

  const { data: rootLead, error: rootLeadError } = await supabaseAdmin
    .from("leads")
    .select(
      "id, lead_type, price, selling_price, address_street, address_unit, address_city, address_province, address_postal_code, selling_address_street, selling_address_unit, selling_address_city, selling_address_province, selling_address_postal_code",
    )
    .eq("id", rootLeadId)
    .single();

  if (rootLeadError || !rootLead) {
    return NextResponse.json(
      { success: false, error: "Primary lead not found" },
      { status: 404 },
    );
  }

  // ── Validate the requested role against the deal type ─────────────────────
  // A Purchase & Sale deal can take both sides; a single-side deal only its own.
  const dealTypeLower = String(deal.type ?? "").toLowerCase();
  const isCombinedPS =
    dealTypeLower.includes("purchase") && dealTypeLower.includes("sale");
  const allowsPurchaser = isCombinedPS || dealTypeLower.includes("purchase") || dealTypeLower.includes("refinance");
  const allowsSeller = isCombinedPS || dealTypeLower === "sale" || dealTypeLower.includes("sale");

  if (role === "purchaser" && !allowsPurchaser) {
    return NextResponse.json(
      { success: false, error: "This deal type cannot take a co-purchaser" },
      { status: 400 },
    );
  }
  if (role === "seller" && !allowsSeller) {
    return NextResponse.json(
      { success: false, error: "This deal type cannot take a co-seller" },
      { status: 400 },
    );
  }

  // ── Guard against re-adding someone already in the family ─────────────────
  const emailPattern = email.replace(/[\\%_]/g, "\\$&");
  const { data: familyDup } = await supabaseAdmin
    .from("leads")
    .select("id")
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`)
    .ilike("email", emailPattern)
    .maybeSingle();

  if (familyDup) {
    return NextResponse.json(
      {
        success: false,
        error: "Someone with this email is already part of this file",
      },
      { status: 409 },
    );
  }

  // ── Build the child lead row ──────────────────────────────────────────────
  // A co-purchaser lives on the purchase side; a co-seller on the sale side.
  // The property is the SAME as the primary's, so we copy the relevant address
  // off the root lead. convertSingleLead derives the deal's property_address
  // from address_street, so for a co-seller we also seed address_* with the
  // selling address (and keep selling_address_* so "People Involved" shows the
  // sale property explicitly).
  const isPurchaser = role === "purchaser";

  const childInsert: Record<string, any> = {
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    parent_lead_id: rootLeadId,
    co_person_role: role,
    lead_type: isPurchaser ? "Purchase" : "Sale",
    status: "New",
    price: rootLead.price ?? null,
  };

  if (isPurchaser) {
    childInsert.address_street = rootLead.address_street ?? null;
    childInsert.address_unit = rootLead.address_unit ?? null;
    childInsert.address_city = rootLead.address_city ?? null;
    childInsert.address_province = rootLead.address_province ?? null;
    childInsert.address_postal_code = rootLead.address_postal_code ?? null;
  } else {
    const sStreet = rootLead.selling_address_street ?? null;
    const sUnit = rootLead.selling_address_unit ?? null;
    const sCity = rootLead.selling_address_city ?? null;
    const sProvince = rootLead.selling_address_province ?? null;
    const sPostal = rootLead.selling_address_postal_code ?? null;
    childInsert.selling_address_street = sStreet;
    childInsert.selling_address_unit = sUnit;
    childInsert.selling_address_city = sCity;
    childInsert.selling_address_province = sProvince;
    childInsert.selling_address_postal_code = sPostal;
    // Mirror onto address_* so the Sale deal's property_address resolves.
    childInsert.address_street = sStreet;
    childInsert.address_unit = sUnit;
    childInsert.address_city = sCity;
    childInsert.address_province = sProvince;
    childInsert.address_postal_code = sPostal;
  }

  const { data: childLead, error: childError } = await supabaseAdmin
    .from("leads")
    .insert(childInsert)
    .select("*")
    .single();

  if (childError || !childLead) {
    return NextResponse.json(
      { success: false, error: `Failed to add co-client: ${childError?.message}` },
      { status: 500 },
    );
  }

  // ── Run the existing conversion flow on the new co-lead ───────────────────
  // existingDealBehavior "skip" matches how the family-convert path calls it.
  // This creates the co-lead's deal, seeds its (non-shared) tasks, syncs
  // completed shared tasks from the family, and sends the invite + welcome
  // emails — all reused, nothing changed.
  const convert = await convertSingleLead(childLead, {
    existingDealBehavior: "skip",
  });

  if (!convert.success) {
    // The lead row exists but conversion failed — surface it so the admin can
    // retry from the Leads page rather than leaving a silent orphan.
    return NextResponse.json(
      {
        success: false,
        error: convert.error ?? "Co-client added but conversion failed",
        lead_id: childLead.id,
      },
      { status: convert.statusCode ?? 500 },
    );
  }

  return NextResponse.json({
    success: true,
    lead_id: childLead.id,
    deal_id: convert.deal_id,
    file_number: convert.file_number,
    invite_sent: convert.invite_sent ?? false,
    already_has_login: convert.already_has_login ?? false,
    role: isPurchaser ? "Co-Purchaser" : "Co-Seller",
  });
}
