import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabase = supabaseAdmin;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { data, error } = await supabase
    .from("deals")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // ── Fetch linked deals (co-purchaser relationships) ──────────────────────
  let linked_deals: any[] = [];

  try {
    if (data.lead_id) {
      // Step 1: Get the lead to find parent_lead_id and selling-side address
      const { data: lead } = await supabase
        .from("leads")
        .select("id, parent_lead_id, first_name, last_name, citizenship_status, lead_type, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code")
        .eq("id", data.lead_id)
        .single();

      if (lead) {
        data.lead_citizenship_status = lead.citizenship_status ?? null;
        data.selling_property_address = [
          lead.selling_address_street,
          lead.selling_address_city,
          lead.selling_address_province,
          lead.selling_address_postal_code,
        ]
          .filter(Boolean)
          .join(", ");
        const rootLeadId = lead.parent_lead_id ?? lead.id;

        // Step 2: Find all leads in the family
        const { data: familyLeads } = await supabase
          .from("leads")
          .select("id, parent_lead_id, first_name, last_name, lead_type, selling_address_street")
          .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

        // Determine a co-lead's role from its own lead_type when specific
        // (Purchase/Sale). When ambiguous (e.g. "Purchase & Sale" mirrored
        // from the parent), fall back to selling_address_street presence —
        // only co-sellers carry a selling-side address — then to the deal's
        // own type.
        const dealTypeLower = (data.type ?? "").toLowerCase().trim();
        const dealIsSaleOnly = dealTypeLower === "sale";
        const labelForCo = (
          leadType: string | null | undefined,
          sellingAddressStreet?: string | null,
        ): string => {
          const lt = (leadType ?? "").toLowerCase().trim();
          const hasPurchase = lt.includes("purchase");
          const hasSale = lt.includes("sale");
          if (hasSale && !hasPurchase) return "Co-Seller";
          if (hasPurchase && !hasSale) return "Co-Purchaser";
          if (sellingAddressStreet) return "Co-Seller";
          return dealIsSaleOnly ? "Co-Seller" : "Co-Purchaser";
        };
        const labelForPrimary = (leadType: string | null | undefined): string => {
          const lt = (leadType ?? "").toLowerCase().trim();
          if (lt.includes("purchase") && lt.includes("sale")) return "Primary Client";
          if (lt === "sale") return "Primary Seller";
          if (lt === "purchase") return "Primary Purchaser";
          return dealIsSaleOnly ? "Primary Seller" : "Primary Purchaser";
        };

        if (familyLeads && familyLeads.length > 1) {
          // Get all family lead IDs except the current deal's lead
          const otherLeadIds = familyLeads
            .filter((l) => l.id !== lead.id)
            .map((l) => l.id);

          if (otherLeadIds.length > 0) {
            // Step 3: Find deals for those leads
            const { data: otherDeals } = await supabase
              .from("deals")
              .select("id, file_number, property_address, lead_id, status")
              .in("lead_id", otherLeadIds);

            if (otherDeals) {
              // Build a map of lead_id → lead info
              const leadMap = new Map(
                familyLeads.map((l) => [l.id, l])
              );

              linked_deals = otherDeals.map((d) => {
                const dLead = leadMap.get(d.lead_id) as any;
                const isPrimary = dLead ? !dLead.parent_lead_id : false;
                const role = isPrimary
                  ? labelForPrimary(dLead?.lead_type)
                  : labelForCo(dLead?.lead_type, dLead?.selling_address_street);
                return {
                  id: d.id,
                  file_number: d.file_number,
                  property_address: d.property_address,
                  status: d.status,
                  lead_name: dLead
                    ? `${dLead.first_name ?? ""} ${dLead.last_name ?? ""}`.trim()
                    : null,
                  role,
                };
              });
            }
          }

          // Also determine the current deal's role
          data.current_deal_role = lead.parent_lead_id
            ? labelForCo(lead.lead_type, lead.selling_address_street)
            : labelForPrimary(lead.lead_type);
        }
      }
    }
  } catch (err) {
    // Non-blocking — don't fail the whole request
    console.error("[DealDetail] Failed to fetch linked deals:", err);
  }

  return NextResponse.json({ ...data, linked_deals });
}

// Whitelist of deal columns that can be updated from the edit modal.
// Keeps the endpoint safe from arbitrary writes (audit/created_at/etc.).
const EDITABLE_DEAL_COLUMNS = new Set([
  "file_number",
  "file_name",
  "type",
  "status",
  "lawyer_name",
  "clerk_name",
  "property_address",
  "closing_date",
  "opening_date",
  "requisition_date",
  "price",
  "outstanding_undertakings",
  "outstanding_requisitions",
]);

const ALLOWED_TYPES = new Set([
  "Purchase",
  "Sale",
  "Refinance",
  "Purchase & Sale",
]);

const ALLOWED_STATUSES = new Set([
  "Active",
  "Pending",
  "Closed",
  "Cancelled",
  "Urgent",
]);

const DATE_COLUMNS = new Set([
  "closing_date",
  "opening_date",
  "requisition_date",
]);

// Postgres accepts wild years; clamp at the API to match the UI constraint
// and stop a stray 6-digit year from being persisted.
const DATE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MIN = "1900-01-01";
const DATE_MAX = "2100-12-31";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
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

  const updates: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_DEAL_COLUMNS.has(key)) continue;
    if (key === "type" && value && !ALLOWED_TYPES.has(value)) {
      return NextResponse.json(
        { success: false, error: `Invalid type: ${value}` },
        { status: 400 },
      );
    }
    if (key === "status" && value && !ALLOWED_STATUSES.has(value)) {
      return NextResponse.json(
        { success: false, error: `Invalid status: ${value}` },
        { status: 400 },
      );
    }
    if (DATE_COLUMNS.has(key)) {
      // Empty strings on date columns must be sent as null so Postgres accepts them.
      if (value === "" || value === null || value === undefined) {
        updates[key] = null;
        continue;
      }
      if (typeof value !== "string" || !DATE_FORMAT_RE.test(value)) {
        return NextResponse.json(
          { success: false, error: `Invalid ${key}: expected YYYY-MM-DD` },
          { status: 400 },
        );
      }
      if (value < DATE_MIN || value > DATE_MAX) {
        return NextResponse.json(
          {
            success: false,
            error: `${key} must be between ${DATE_MIN} and ${DATE_MAX}`,
          },
          { status: 400 },
        );
      }
    }
    updates[key] = value;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { success: false, error: "No editable fields supplied" },
      { status: 400 },
    );
  }

  // file_number has a UNIQUE index — surface a friendly error for duplicates.
  if (typeof updates.file_number === "string") {
    const trimmed = updates.file_number.trim();
    if (!trimmed) {
      return NextResponse.json(
        { success: false, error: "File number cannot be empty" },
        { status: 400 },
      );
    }
    updates.file_number = trimmed;
  }

  const { data, error } = await supabase
    .from("deals")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    const friendly =
      error.code === "23505"
        ? "File number already in use"
        : error.message;
    return NextResponse.json(
      { success: false, error: friendly },
      { status: 400 },
    );
  }

  return NextResponse.json({ success: true, data });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { error } = await supabase
    .from("deals")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
