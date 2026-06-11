import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const leadId = searchParams.get("lead_id");
  const dealId = searchParams.get("deal_id");

  // If deal_id is provided, fetch docs from ALL family leads (for co-purchaser support)
  if (dealId) {
    try {
      const familyDealIds = await getFamilyDealIds(dealId);

      const { data: familyDeals } = await supabaseAdmin
        .from("deals")
        .select("lead_id")
        .in("id", familyDealIds)
        .eq("is_deleted", false);

      const familyLeadIds = [...new Set((familyDeals ?? []).map((d) => d.lead_id).filter(Boolean))];

      if (familyLeadIds.length === 0) {
        return NextResponse.json([]);
      }

      const { data: activeFamilyLeads, error: activeLeadErr } = await supabaseAdmin
        .from("leads")
        .select("id")
        .in("id", familyLeadIds)
        .eq("is_deleted", false);

      if (activeLeadErr) {
        return NextResponse.json({ error: activeLeadErr.message }, { status: 500 });
      }

      const activeFamilyLeadIds = (activeFamilyLeads ?? []).map((l) => l.id);

      if (activeFamilyLeadIds.length === 0) {
        return NextResponse.json([]);
      }

      const { data, error } = await supabaseAdmin
        .from("lead_corporate_docs")
        .select("*")
        .in("lead_id", activeFamilyLeadIds);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      // Deduplicate by file_name (same doc uploaded by different family members)
      const seen = new Set<string>();
      const deduped = (data ?? []).filter((doc) => {
        const key = doc.file_name ?? doc.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return NextResponse.json(deduped);
    } catch {
      return NextResponse.json([]);
    }
  }

  if (!leadId) {
    return NextResponse.json({ error: "lead_id or deal_id is required" }, { status: 400 });
  }

  const { data: activeLead, error: activeLeadErr } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("id", leadId)
    .eq("is_deleted", false)
    .maybeSingle();

  if (activeLeadErr) {
    return NextResponse.json({ error: activeLeadErr.message }, { status: 500 });
  }

  if (!activeLead) {
    return NextResponse.json([]);
  }

  const { data, error } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("*")
    .eq("lead_id", leadId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { lead_id, doc_type, custom_type, file_url, file_name } = body;

    if (!lead_id) {
      return NextResponse.json({ error: "lead_id is required" }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("lead_corporate_docs")
      .insert({ lead_id, doc_type, custom_type, file_url, file_name })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
