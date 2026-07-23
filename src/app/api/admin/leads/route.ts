import { NextRequest, NextResponse } from 'next/server';
import supabaseAdmin from '@/lib/supabaseAdmin';
import { isUuid } from '@/lib/isUuid';
import { recordAudit } from '@/lib/recordAudit';
import { getActingAdmin } from '@/lib/getActingAdmin';

// Admin data must always be live — never serve a cached leads list, otherwise
// an edited phone/name/etc. can keep showing the old value after a refresh.
export const dynamic = 'force-dynamic';

// camelCase payload key → DB column for the LEADS table (transaction fields).
const LEAD_FIELD_MAP: Record<string, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
  addressStreet: 'address_street',
  addressUnit: 'address_unit',
  addressCity: 'address_city',
  addressPostalCode: 'address_postal_code',
  addressProvince: 'address_province',
  propertyType: 'property_type',
  ownershipHistory: 'ownership_history',
  status: 'status',
  leadType: 'lead_type',
  price: 'price',
  service: 'service',
  subService: 'sub_service',
  apsSigned: 'aps_signed',
  referralSource: 'referral_source',
  sellingAddressStreet: 'selling_address_street',
  sellingAddressCity: 'selling_address_city',
  sellingAddressPostalCode: 'selling_address_postal_code',
  sellingAddressProvince: 'selling_address_province',
};

// camelCase payload key → DB column for the CLIENTS table (the person's
// personal/corporate fields). These now live on clients (source of truth),
// not on leads.
const CLIENT_FIELD_MAP: Record<string, string> = {
  isCorporate: 'is_corporate',
  corporateName: 'corporate_name',
  incNumber: 'inc_number',
  maritalStatus: 'marital_status',
  citizenshipStatus: 'citizenship_status',
  occupation: 'occupation',
  employerPhone: 'employer_phone',
};

// GET /api/admin/leads — soft-deleted leads are hidden. They still exist
// in the DB (along with their deals, signatures, and signed PDFs) so an
// admin SQL toggle of is_deleted back to false fully restores them.
export async function GET() {
  // Personal/corporate fields are sourced from the linked customer record
  // (public.clients) — the source of truth — and overlaid onto each lead under
  // the same keys, so the Leads UI is unchanged. Falls back to the lead's own
  // value during the transition (before those lead columns are dropped).
  const { data, error } = await supabaseAdmin
    .from('leads')
    .select(
      '*, clients:client_id(marital_status, citizenship_status, occupation, employer_phone, is_corporate, corporate_name, inc_number, corporate_email)',
    )
    .eq('is_deleted', false)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  const leads = (data ?? []).map((row: any) => {
    const c = row.clients ?? null;
    const { clients: _c, ...lead } = row;
    if (c) {
      // The 4 personal fields now live only on clients.
      lead.marital_status = c.marital_status ?? null;
      lead.citizenship_status = c.citizenship_status ?? null;
      lead.occupation = c.occupation ?? null;
      lead.employer_phone = c.employer_phone ?? null;
      // Corporate columns still exist on leads (written at intake) — prefer the
      // client's value, fall back to the lead's.
      lead.is_corporate = c.is_corporate ?? lead.is_corporate;
      lead.corporate_name = c.corporate_name ?? lead.corporate_name;
      lead.inc_number = c.inc_number ?? lead.inc_number;
      lead.corporate_email = c.corporate_email ?? lead.corporate_email;
    }
    return lead;
  });

  // ── Referral attribution ─────────────────────────────────────────────────
  // Resolve each lead's referring partner in bulk. The partner's own
  // referral_code is the referral code — coupons are no longer read. Done as a
  // separate query (not an embedded select) so this is migration-safe: before
  // the partner_id column exists, `*` simply omits it and this no-ops.
  const partnerIds = [...new Set(leads.map((l: any) => l.partner_id).filter(Boolean))];
  const partnerMap = new Map<string, any>();

  if (partnerIds.length > 0) {
    const { data: partners } = await supabaseAdmin
      .from("partners")
      .select("id, agent_name, agent_email, agent_phone, brokerage_type, brokerage_name, referral_code")
      .in("id", partnerIds)
      // Exclude soft-deleted partners — a deleted partner must not resurface as
      // a lead's referral just because the lead still carries its partner_id.
      .eq("is_deleted", false);
    for (const p of partners ?? []) partnerMap.set(p.id, p);
  }

  for (const lead of leads as any[]) {
    lead.referral_partner = lead.partner_id
      ? partnerMap.get(lead.partner_id) ?? null
      : null;
  }

  return NextResponse.json({ success: true, leads });
}

// PUT /api/admin/leads — update a lead's editable fields
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, ...rest } = body ?? {};

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'id is required' },
        { status: 400 },
      );
    }

    const norm = (value: unknown) =>
      typeof value === 'string' && value.trim() === '' ? null : value;

    // Split incoming fields: transaction fields → leads, personal/corporate
    // fields → clients (the source of truth for those).
    // first_name / last_name are NOT NULL in the DB and legitimately empty for
    // some records (e.g. a person with only a first name). Never null these —
    // coerce a blank to '' so the update satisfies the constraint instead of
    // failing with "null value in column ... violates not-null constraint".
    const NOT_NULL_TEXT_COLUMNS = new Set(['first_name', 'last_name']);
    const updateData: Record<string, any> = {};
    for (const [key, column] of Object.entries(LEAD_FIELD_MAP)) {
      if (rest[key] === undefined) continue;
      if (NOT_NULL_TEXT_COLUMNS.has(column)) {
        const raw = rest[key];
        updateData[column] =
          typeof raw === 'string' && raw.trim() === '' ? '' : raw;
      } else {
        updateData[column] = norm(rest[key]);
      }
    }

    // GAP-016: validate email format before writing it. (We intentionally do NOT
    // reject "duplicate" emails: the same person legitimately has multiple leads
    // sharing one email — co-client cascades key off exactly that — so a
    // uniqueness check would break normal editing. Format is the safe guard.)
    if (updateData.email != null) {
      const email = String(updateData.email).trim();
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!EMAIL_RE.test(email)) {
        return NextResponse.json(
          { success: false, error: 'Invalid email address' },
          { status: 400 },
        );
      }
      updateData.email = email;
    }

    const clientData: Record<string, any> = {};
    for (const [key, column] of Object.entries(CLIENT_FIELD_MAP)) {
      if (rest[key] !== undefined) clientData[column] = norm(rest[key]);
    }
    // Phone is a transaction field on leads, but the customer record (clients)
    // keeps its own copy that the customer portal reads. Mirror it so an admin
    // phone edit doesn't leave clients.phone stale — the leads→clients trigger
    // syncs the other personal fields but skips phone. (The Personal
    // Information task already keeps both in sync via its own trigger.)
    if (rest.phone !== undefined) clientData.phone = norm(rest.phone);

    // Name has the same gap as phone: the leads→clients trigger
    // (2026-06-03-phaseD-lead-edit-sync-to-clients.sql) syncs the personal
    // fields but NOT first_name/last_name, and the lead→client INSERT trigger
    // is ON CONFLICT DO NOTHING, so it never updates an existing row. Without
    // this mirror an admin rename lands on `leads` only and every surface
    // reading clients.first_name (customer portal, milestone emails) keeps
    // showing the old name. NOT NULL on clients too, so blanks coerce to ''.
    for (const [key, column] of [
      ['firstName', 'first_name'],
      ['lastName', 'last_name'],
    ] as const) {
      if (rest[key] === undefined) continue;
      const raw = rest[key];
      clientData[column] = typeof raw === 'string' && raw.trim() === '' ? '' : raw;
    }

    if (Object.keys(updateData).length === 0 && Object.keys(clientData).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No editable fields provided' },
        { status: 400 },
      );
    }

    // Update the lead's own (transaction) fields.
    let lead: any = null;
    if (Object.keys(updateData).length > 0) {
      const { data, error } = await supabaseAdmin
        .from('leads')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();
      if (error) {
        console.error('PUT /api/admin/leads error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }
      lead = data;
    } else {
      const { data } = await supabaseAdmin.from('leads').select('*').eq('id', id).single();
      lead = data;
    }

    // Write personal/corporate fields to the linked customer record.
    if (Object.keys(clientData).length > 0 && lead) {
      let clientId: string | null = lead.client_id ?? null;
      if (!clientId && lead.email) {
        const emailPattern = String(lead.email).replace(/[\\%_]/g, '\\$&');
        const { data: c } = await supabaseAdmin
          .from('clients')
          .select('id')
          .ilike('email', emailPattern)
          .maybeSingle();
        clientId = c?.id ?? null;
      }
      if (clientId) {
        const { error: clientErr } = await supabaseAdmin
          .from('clients')
          .update(clientData)
          .eq('id', clientId);
        if (clientErr) {
          console.error('PUT /api/admin/leads client update error:', clientErr);
          return NextResponse.json({ success: false, error: clientErr.message }, { status: 500 });
        }
        // Reflect the saved personal fields back onto the returned lead object
        // so the UI (which reads lead.*) shows the new values immediately.
        Object.assign(lead, clientData);
      }
    }

    // Phone and name are personal attributes of the PERSON, not of one deal. A
    // client can have several deals — each is its own leads row, but they all
    // share the same email — so an edit must update every one of that person's
    // leads (keyed by email), not just the deal being viewed. Co-purchasers /
    // co-sellers have their OWN distinct emails, so matching by email touches
    // only this person's rows. The single customer record (clients.*) was
    // already updated above. Non-fatal: this lead + clients are saved even if
    // the cross-deal cascade fails.
    const personCascade: Record<string, any> = {};
    if (rest.phone !== undefined) personCascade.phone = norm(rest.phone);
    if (updateData.first_name !== undefined)
      personCascade.first_name = updateData.first_name;
    if (updateData.last_name !== undefined)
      personCascade.last_name = updateData.last_name;
    if (Object.keys(personCascade).length > 0 && lead?.email) {
      const emailPattern = String(lead.email).replace(/[\\%_]/g, '\\$&');
      const { error: cascadeErr } = await supabaseAdmin
        .from('leads')
        .update(personCascade)
        .ilike('email', emailPattern);
      if (cascadeErr) {
        console.error('PUT /api/admin/leads person cascade error:', cascadeErr);
      }
    }

    return NextResponse.json({ success: true, lead });
  } catch (err: any) {
    console.error('PUT /api/admin/leads exception:', err);
    return NextResponse.json(
      { success: false, error: err.message ?? 'Unknown error' },
      { status: 500 },
    );
  }
}

// DELETE /api/admin/leads?id=...
//
// Soft delete: we set is_deleted=true on the lead and on every co-lead in the
// same family. Nothing else is touched — deals, retainer_signatures, tasks,
// milestones, and signed PDFs all stay intact, so a future "restore" is just
// `UPDATE leads SET is_deleted=false WHERE id=...`. This also sidesteps the
// FK constraint errors (retainer_signatures_lead_id_fkey etc.) that hard
// deletes hit.
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  // SEC-013: `id` is spliced into the .or() filter below, so reject anything
  // that isn't a UUID instead of interpolating it into the query.
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  }

  // Soft-delete the primary lead and every co-lead in the same family in one
  // call. The OR predicate matches the lead itself plus any row whose
  // parent_lead_id points at it, so deleting a primary lead hides the whole
  // co-purchaser/co-seller group from the listing in one shot.
  const { error } = await supabaseAdmin
    .from("leads")
    .update({ is_deleted: true })
    .or(`id.eq.${id},parent_lead_id.eq.${id}`);

  if (error) {
    return NextResponse.json(
      { success: false, error: `Failed to delete lead: ${error.message}` },
      { status: 500 },
    );
  }

  // SEC-006 / CMP-004: record who deleted which lead (and its family).
  const actor = await getActingAdmin();
  await recordAudit({
    action: "lead.delete",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "lead",
    resourceId: id,
    req,
  });

  return NextResponse.json({ success: true });
}
