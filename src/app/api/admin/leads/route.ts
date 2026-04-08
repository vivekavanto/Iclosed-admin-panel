import { NextResponse } from 'next/server';
import supabaseAdmin from '@/lib/supabaseAdmin';
import { convertSingleLead } from '@/lib/convertLead';

// GET /api/admin/leads
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  const leads = data ?? [];

  // Auto-link: if a lead has address_match_flag.matched_lead_id but no parent_lead_id,
  // set parent_lead_id now — but ONLY if the emails are different.
  // Same email = same person submitting again (new lead, NOT a co-purchaser).
  // Different email + same address = actual co-purchaser.
  for (const lead of leads) {
    if (!lead.parent_lead_id && lead.address_match_flag?.matched_lead_id) {
      const matchedId = lead.address_match_flag.matched_lead_id;
      const matchedLead = leads.find((l) => l.id === matchedId);

      // Only auto-link if emails are different (different person)
      if (matchedLead && matchedLead.email?.toLowerCase() !== lead.email?.toLowerCase()) {
        const rootLeadId = matchedLead.parent_lead_id ?? matchedId;

        await supabaseAdmin
          .from('leads')
          .update({
            parent_lead_id: rootLeadId,
            address_match_flag: null,
          })
          .eq('id', lead.id);

        lead.parent_lead_id = rootLeadId;
        lead.address_match_flag = null;

        // Auto-convert: if the primary lead already has a deal, convert this co-purchaser too
        try {
          const { data: primaryDeal } = await supabaseAdmin
            .from('deals')
            .select('id, closing_date')
            .eq('lead_id', rootLeadId)
            .maybeSingle();

          if (primaryDeal && lead.status !== 'Converted') {
            // Primary already converted — auto-convert this co-purchaser
            const result = await convertSingleLead(lead, {
              closing_date: primaryDeal.closing_date ?? undefined,
              existingDealBehavior: 'skip',
            });

            if (result.success && result.created) {
              lead.status = 'Converted';
              console.log(`[AutoConvert] Co-purchaser ${lead.email} auto-converted to deal ${result.file_number}`);
            }
          }
        } catch (err) {
          console.error(`[AutoConvert] Failed for co-purchaser ${lead.email}:`, err);
        }
      } else {
        // Same email — just clear the flag, don't link
        await supabaseAdmin
          .from('leads')
          .update({ address_match_flag: null })
          .eq('id', lead.id);

        lead.address_match_flag = null;
      }
    }
  }

  return NextResponse.json({ success: true, leads });
}

// DELETE /api/admin/leads?id=...
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
