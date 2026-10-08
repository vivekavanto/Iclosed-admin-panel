import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { isUuid } from "@/lib/isUuid";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { FILE_NUMBER_REGEX, FILE_NUMBER_HINT } from "@/lib/fileNumber";
import { normalizeRecipientEmail } from "@/lib/emailIdentity";
import { partnerCcAddresses } from "@/lib/partnerCcAddresses";

const supabase = supabaseAdmin;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid deal id" }, { status: 400 });
  }
  const { data, error } = await supabase
    .from("deals")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // ── Referral attribution ─────────────────────────────────────────────────
  // If this deal was referred (partner_id set at intake), resolve the partner so
  // the detail page can show who referred the file. The partner's own
  // referral_code is the referral code — coupons are no longer read.
  data.referral_partner = null;
  if (data.partner_id) {
    const { data: partner } = await supabase
      .from("partners")
      .select("id, agent_name, agent_email, agent_phone, brokerage_type, brokerage_name, referral_code")
      .eq("id", data.partner_id)
      // Exclude soft-deleted partners so a deleted partner doesn't resurface as
      // the deal's referral (Partner Details card / email CC).
      .eq("is_deleted", false)
      .maybeSingle();
    data.referral_partner = partner ?? null;
  }

  // Addresses this file is CC'd on via the partner rather than via
  // deals.cc_emails. Surfaced so the Email CC panel can show the complete CC
  // line instead of only its own editable half.
  data.partner_cc_emails = await partnerCcAddresses(id);

  // Resolve "account created" (last_sign_in_at) for the current lead and
  // every family member. Mirrors the All Files list so the detail page
  // can show the same Pending/Active and per-person Active/Inactive
  // status that the list does.
  const accountCreatedByAuthId = new Map<string, string>();
  const accountCreatedByLeadId = new Map<string, string | null>();

  // ── Fetch linked deals (co-purchaser relationships) ──────────────────────
  let linked_deals: any[] = [];

  try {
    if (data.lead_id) {
      // Step 1: Get the lead to find parent_lead_id and selling-side address
      const { data: lead } = await supabase
        .from("leads")
        .select("id, parent_lead_id, client_id, first_name, last_name, email, phone, property_type, ownership_history, corporate_name, inc_number, lead_type, co_person_role, address_street, address_unit, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code")
        .eq("id", data.lead_id)
        .single();

      if (lead) {
        // Source the person's personal/corporate fields from the CUSTOMER
        // record (public.clients), which is the source of truth for these.
        // Resolve the client by client_id, else by email. Fall back to the
        // lead's own value during the transition (before the lead columns are
        // dropped). Address/property fields stay on the lead.
        let person:
          | {
              marital_status: string | null;
              citizenship_status: string | null;
              occupation: string | null;
              employer_phone: string | null;
              corporate_name: string | null;
              inc_number: string | null;
            }
          | null = null;
        const personCols =
          "marital_status, citizenship_status, occupation, employer_phone, corporate_name, inc_number";
        if (lead.client_id) {
          const { data: c } = await supabase
            .from("clients")
            .select(personCols)
            .eq("id", lead.client_id)
            .maybeSingle();
          person = c ?? null;
        }
        if (!person && lead.email) {
          const emailPattern = lead.email.replace(/[\\%_]/g, "\\$&");
          const { data: c } = await supabase
            .from("clients")
            .select(personCols)
            .ilike("email", emailPattern)
            .maybeSingle();
          person = c ?? null;
        }

        data.lead_citizenship_status = person?.citizenship_status ?? null;
        // Personal / contact details surfaced so the Edit Task modal can
        // pre-fill template fields (e.g. "Personal Information" task) from
        // the lead's existing record instead of leaving them blank.
        data.lead_first_name = lead.first_name ?? null;
        data.lead_last_name = lead.last_name ?? null;
        data.lead_email = lead.email ?? null;
        data.lead_phone = lead.phone ?? null;
        data.lead_employer_phone = person?.employer_phone ?? null;
        data.lead_occupation = person?.occupation ?? null;
        data.lead_marital_status = person?.marital_status ?? null;
        data.lead_property_type = lead.property_type ?? null;
        data.lead_ownership_history = lead.ownership_history ?? null;
        data.lead_corporate_name = person?.corporate_name ?? lead.corporate_name ?? null;
        data.lead_inc_number = person?.inc_number ?? lead.inc_number ?? null;
        // Purchase-side address parts surfaced for the deal-detail UI, which
        // shows city/province/postal under the property heading. The deal's
        // own `property_address` is a single string, so the structured parts
        // live on the lead.
        data.lead_address_street = lead.address_street ?? null;
        data.lead_address_unit = lead.address_unit ?? null;
        data.lead_address_city = lead.address_city ?? null;
        data.lead_address_province = lead.address_province ?? null;
        data.lead_address_postal_code = lead.address_postal_code ?? null;
        data.lead_selling_address_street = lead.selling_address_street ?? null;
        data.lead_selling_address_city = lead.selling_address_city ?? null;
        data.lead_selling_address_province = lead.selling_address_province ?? null;
        data.lead_selling_address_postal_code = lead.selling_address_postal_code ?? null;
        data.selling_property_address = [
          lead.selling_address_street,
          lead.selling_address_city,
          lead.selling_address_province,
          lead.selling_address_postal_code,
        ]
          .filter(Boolean)
          .join(", ");
        const rootLeadId = lead.parent_lead_id ?? lead.id;

        // Step 2: Find all leads in the family. rootLeadId is spliced into an
        // .or() filter string, so guard it as a UUID (SEC-013) — it comes from a
        // DB row here, but never interpolate an unvalidated id into a filter.
        const { data: familyLeads } = isUuid(rootLeadId)
          ? await supabase
              .from("leads")
              .select(
                "id, parent_lead_id, first_name, last_name, corporate_name, email, phone, lead_type, co_person_role, upload_mode, upload_consent_uploader_lead_id, address_street, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code, client_id",
              )
              .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`)
          : { data: null };

        // Resolve the family's designated uploader from the PRIMARY lead's
        // upload_mode (set from the client portal's post-retainer popup →
        // leads.upload_mode / upload_consent_uploader_lead_id on the root lead):
        //   'me'          → the primary uploads for everyone
        //   'co'          → the co-person in upload_consent_uploader_lead_id does
        //   'both'/unset  → each person uploads their own (no single uploader)
        // These fields always live on the root lead regardless of which family
        // member's deal is being viewed.
        const rootLead = (familyLeads ?? []).find(
          (l) => l.id === rootLeadId,
        ) as { upload_mode?: string | null; upload_consent_uploader_lead_id?: string | null } | undefined;
        let designatedUploaderLeadId: string | null = null;
        if (rootLead?.upload_mode === "me") {
          designatedUploaderLeadId = rootLeadId;
        } else if (rootLead?.upload_mode === "co") {
          designatedUploaderLeadId = rootLead.upload_consent_uploader_lead_id ?? null;
        } else {
          designatedUploaderLeadId = null; // 'both' or unset
        }
        // Drives the "Submit on behalf" section on the primary's deal view:
        // shown when the primary is the family's designated uploader.
        data.primary_submit_on_behalf = designatedUploaderLeadId === rootLeadId;
        data.can_upload_for_all = designatedUploaderLeadId === lead.id;

        // Raw values for the "Who uploads documents" reassign control
        // (PATCH /api/admin/deals/[id]/upload-mode). Kept UNRESOLVED on purpose:
        // a null upload_mode means the question was never answered, and the two
        // apps disagree on what that implies (the portal treats it as 'me', this
        // app as 'both'). Surfacing the raw null lets the UI say "not set" and
        // prompt the admin to settle it, rather than showing a guess as fact.
        data.upload_mode = rootLead?.upload_mode ?? null;
        data.upload_uploader_lead_id = designatedUploaderLeadId;
        data.root_lead_id = rootLeadId;

        // Determine a co-lead's role. Priority order:
        //   1. Authoritative `co_person_role` recorded at intake — the
        //      only reliable source on a Purchase & Sale parent where
        //      both co-leads share both addresses.
        //   2. Specific lead_type ("Purchase" → co-purchaser, etc).
        //   3. selling_address_street presence (only set for co-sellers
        //      on non-P&S families).
        //   4. Fall back to the deal's own type.
        const dealTypeLower = (data.type ?? "").toLowerCase().trim();
        const dealIsSaleOnly = dealTypeLower === "sale";
        const labelForCo = (
          leadType: string | null | undefined,
          sellingAddressStreet?: string | null,
          coPersonRole?: string | null,
        ): string => {
          if (coPersonRole === "purchaser") return "Co-Purchaser";
          if (coPersonRole === "seller") return "Co-Seller";
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

        // Look up auth_user_id for every lead in the family (including
        // the current one) so we can resolve last_sign_in_at in a single
        // listUsers pass below. The leads → clients relationship lives on
        // leads.client_id (clients has no lead_id column), so we collect
        // client_ids off the family rows and join from there.
        const familyLeadsForLookup = (familyLeads ?? [lead]) as any[];
        const allFamilyLeadIds = familyLeadsForLookup.map((l) => l.id);
        const clientIds = Array.from(
          new Set(familyLeadsForLookup.map((l) => l.client_id).filter(Boolean) as string[]),
        );
        const { data: familyClients } = clientIds.length > 0
          ? await supabase
              .from("clients")
              .select("id, auth_user_id")
              .in("id", clientIds)
          : { data: [] as { id: string; auth_user_id: string | null }[] };
        const authIdByClientId = new Map<string, string>();
        const familyAuthIds = new Set<string>();
        for (const c of familyClients ?? []) {
          if (c.auth_user_id) {
            authIdByClientId.set(c.id, c.auth_user_id);
            familyAuthIds.add(c.auth_user_id);
          }
        }
        const authIdByLeadId = new Map<string, string>();
        for (const fl of familyLeadsForLookup) {
          const authId = fl.client_id ? authIdByClientId.get(fl.client_id) : undefined;
          if (authId) authIdByLeadId.set(fl.id, authId);
        }
        if (familyAuthIds.size > 0) {
          try {
            let page = 1;
            const perPage = 1000;
            while (true) {
              const { data: usersPage } = await supabase.auth.admin.listUsers({ page, perPage });
              const users = usersPage?.users ?? [];
              for (const u of users) {
                if (familyAuthIds.has(u.id) && u.last_sign_in_at) {
                  accountCreatedByAuthId.set(u.id, u.last_sign_in_at);
                }
              }
              if (users.length < perPage) break;
              page += 1;
            }
          } catch (err) {
            console.error("[admin/deals/:id] listUsers failed (non-blocking):", err);
          }
        }
        for (const leadId of allFamilyLeadIds) {
          const authId = authIdByLeadId.get(leadId);
          accountCreatedByLeadId.set(
            leadId,
            authId ? accountCreatedByAuthId.get(authId) ?? null : null,
          );
        }
        data.account_created_at = accountCreatedByLeadId.get(lead.id) ?? null;

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
              .in("lead_id", otherLeadIds)
              .eq("is_deleted", false);

            if (otherDeals) {
              // Build a map of lead_id → lead info
              const leadMap = new Map(
                familyLeads.map((l) => [l.id, l])
              );

              // Batched lookup of each family deal's identification task so the
              // primary's DealDetail page can render an "Upload ID" affordance
              // per co-purchaser/co-seller without N+1 calls. Matches the
              // client-side detector at DealDetail.tsx (title contains "identif").
              const idTaskDealIds = [id, ...otherDeals.map((d) => d.id)];
              const { data: idTasksRows } = await supabase
                .from("tasks")
                .select("id, deal_id, status")
                .in("deal_id", idTaskDealIds)
                .ilike("title", "%identif%");
              const idTaskByDealId = new Map<string, { id: string; status: string | null }>();
              for (const t of idTasksRows ?? []) {
                // Prefer the latest if duplicates exist; first-wins is fine for
                // the typical seeded single task per deal.
                if (!idTaskByDealId.has(t.deal_id as string)) {
                  idTaskByDealId.set(t.deal_id as string, {
                    id: t.id as string,
                    status: (t.status as string | null) ?? null,
                  });
                }
              }

              linked_deals = otherDeals.map((d) => {
                const dLead = leadMap.get(d.lead_id) as any;
                const isPrimary = dLead ? !dLead.parent_lead_id : false;
                const role = isPrimary
                  ? labelForPrimary(dLead?.lead_type)
                  : labelForCo(
                      dLead?.lead_type,
                      dLead?.selling_address_street,
                      dLead?.co_person_role,
                    );
                const idTask = idTaskByDealId.get(d.id);
                // Per-lead selling address — derived from the lead row so
                // co-sellers can show what they're actually selling instead
                // of the deal's stored purchase address.
                const leadSellingAddress = dLead
                  ? [
                      dLead.selling_address_street,
                      dLead.selling_address_city,
                      dLead.selling_address_province,
                      dLead.selling_address_postal_code,
                    ]
                      .filter(Boolean)
                      .join(", ")
                  : "";
                return {
                  id: d.id,
                  file_number: d.file_number,
                  property_address: d.property_address,
                  selling_property_address: leadSellingAddress || null,
                  status: d.status,
                  account_created_at: accountCreatedByLeadId.get(d.lead_id) ?? null,
                  lead_id: d.lead_id,
                  lead_name: dLead
                    ? `${dLead.first_name ?? ""} ${dLead.last_name ?? ""}`.trim()
                    : null,
                  lead_corporate_name: dLead?.corporate_name ?? null,
                  lead_email: dLead?.email ?? null,
                  lead_phone: dLead?.phone ?? null,
                  role,
                  can_upload_for_all: dLead ? designatedUploaderLeadId === dLead.id : false,
                  identification_task_id: idTask?.id ?? null,
                  identification_status: idTask?.status ?? null,
                };
              });

              // Surface the same fields for the current/primary deal so the
              // primary row in "People Involved" can render the same control.
              const primaryIdTask = idTaskByDealId.get(id);
              data.identification_task_id = primaryIdTask?.id ?? null;
              data.identification_status = primaryIdTask?.status ?? null;
            }
          }
          // Also determine the current deal's role
          data.current_deal_role = lead.parent_lead_id
            ? labelForCo(
                lead.lead_type,
                lead.selling_address_street,
                (lead as any).co_person_role,
              )
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
  // Lock box code — a per-deal property attribute for Purchase files (surfaced
  // only on Purchase / P&S deals in the Edit modal). Feeds the {{ lockbox_code }}
  // milestone-email variable. Deliberately NOT in MIRROR_DEAL_COLUMNS: like
  // property_address it stays per-deal, so it never leaks onto a family's
  // Sale-side deal.
  "lockbox_code",
  "garage_access_code",
  "closing_date",
  // Sale-side closing date on a Purchase & Sale file. A P&S family is ONE deal
  // row carrying both sides (like selling_price / selling_property_address), so
  // the two closing dates sit side by side rather than on separate rows. Seeded
  // from leads.selling_closing_date at conversion, then owned by the file.
  "selling_closing_date",
  "opening_date",
  "requisition_date",
  "price",
  // Deposit already paid on the purchase. Seeded from the lead at conversion,
  // then owned by the file — same relationship price has to leads.price.
  "deposit_amount",
  "outstanding_undertakings",
  "outstanding_requisitions",
  // Extra people CC'd on this file's "Shared with agent" emails, on top of the
  // referral partner's own contacts. A file-level property, so it mirrors
  // across the family below — one file, one CC list.
  "cc_emails",
  // Internal free-text note on where the file is at, typed inline on the All
  // Files list. Never shown to the client and not readable from any email
  // template. File-level, so it mirrors across the family below.
  "admin_note",
  // Whose signing calendar the client sees (signing_lawyers.initials). Admin
  // only, never shown to the client. NULL = use signing_settings default.
  // File-level, so it mirrors across the family below.
  "signing_with",
]);

const ALLOWED_TYPES = new Set([
  "Purchase",
  "Sale",
  "Refinance",
  "Purchase & Sale",
]);

const ALLOWED_STATUSES = new Set([
  "Active",
  "Inactive",
  "Closed",
]);

// Columns that should mirror across every deal in the same co-purchaser/
// co-seller family. Notes:
//   - file_number: all parties to one file share ONE number, so renaming the
//     file cascades to every family deal (the partial unique index only
//     constrains primaries, so co-clients duplicating the number is allowed).
//   - type: a Purchase & Sale family has Purchase on one row, Sale on another
//   - property_address: same reason — purchase address vs selling address
const MIRROR_DEAL_COLUMNS = new Set([
  "file_number",
  "file_name",
  "status",
  "lawyer_name",
  "clerk_name",
  "closing_date",
  "selling_closing_date",
  "opening_date",
  "requisition_date",
  "price",
  "deposit_amount",
  "outstanding_undertakings",
  "outstanding_requisitions",
  "cc_emails",
  "admin_note",
  "admin_note_updated_at",
  "signing_with",
]);

// Cap the note at the API rather than the column type, so an existing longer
// value can never block an unrelated edit to the same deal.
const ADMIN_NOTE_MAX = 500;

const DATE_COLUMNS = new Set([
  "closing_date",
  "selling_closing_date",
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
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid deal id" }, { status: 400 });
  }

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
    // signing_with: blank means "use the default calendar" and is stored as NULL.
    if (key === "signing_with") {
      const v = typeof value === "string" ? value.trim() : "";
      updates[key] = v || null;
      continue;
    }
    // admin_note: a blank note clears the column rather than storing "" — the
    // list renders null and "" identically, and null keeps the "no note yet"
    // state a single value.
    if (key === "admin_note") {
      if (value === null || value === undefined || value === "") {
        updates[key] = null;
        continue;
      }
      if (typeof value !== "string") {
        return NextResponse.json(
          { success: false, error: "admin_note must be a string" },
          { status: 400 },
        );
      }
      const trimmed = value.trim();
      if (trimmed.length > ADMIN_NOTE_MAX) {
        return NextResponse.json(
          {
            success: false,
            error: `Note is too long (max ${ADMIN_NOTE_MAX} characters).`,
          },
          { status: 400 },
        );
      }
      updates[key] = trimmed || null;
      continue;
    }
    // cc_emails: validate and clean here rather than at send time. A bad
    // address makes Resend reject the WHOLE send, so it must never reach the
    // column — the send-side helper drops malformed entries defensively, but
    // the admin should find out at save time, not by an email silently not
    // arriving.
    if (key === "cc_emails") {
      if (!Array.isArray(value)) {
        return NextResponse.json(
          { success: false, error: "cc_emails must be an array" },
          { status: 400 },
        );
      }
      if (value.length > 20) {
        return NextResponse.json(
          { success: false, error: "cc_emails: at most 20 addresses" },
          { status: 400 },
        );
      }
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const entry of value) {
        const email = normalizeRecipientEmail(
          typeof entry === "string" ? entry : "",
        );
        if (!email) continue;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return NextResponse.json(
            { success: false, error: `Invalid CC email address: ${email}` },
            { status: 400 },
          );
        }
        const dedupeKey = email.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        cleaned.push(email);
      }

      // Reject an address the referral partner already carries. The send-side
      // helper unions partner agent_email + partner_contacts + this column and
      // de-dupes, so re-adding one here copies nobody new — it just puts the
      // address in two places, where removing it from the file appears to do
      // nothing. Only NEW entries are checked: an address already stored on the
      // deal (added before this rule, or added to the partner afterwards) stays
      // editable, otherwise the admin could never save the list again to
      // remove it.
      const existing = new Set<string>();
      {
        const { data: current } = await supabase
          .from("deals")
          .select("cc_emails")
          .eq("id", id)
          .maybeSingle();
        for (const e of (current?.cc_emails as string[] | null) ?? []) {
          existing.add(normalizeRecipientEmail(e).toLowerCase());
        }
      }
      const added = cleaned.filter((e) => !existing.has(e.toLowerCase()));
      if (added.length > 0) {
        const fromPartner = await partnerCcAddresses(id);
        const byEmail = new Map(
          fromPartner.map((p) => [p.email.toLowerCase(), p]),
        );
        for (const email of added) {
          const hit = byEmail.get(email.toLowerCase());
          if (hit) {
            return NextResponse.json(
              {
                success: false,
                error:
                  `${email} is already copied on this file through referral partner ` +
                  `${hit.partner}${hit.source === "agent_email" ? " (partner agent email)" : " (partner contact)"} — no need to add it here.`,
              },
              { status: 400 },
            );
          }
        }
      }

      updates[key] = cleaned;
      continue;
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

  // GAP-006: enforce the deal-status state machine on manual status edits —
  // Active ↔ Inactive, either → Closed; Closed is terminal. Rejects illegal
  // transitions (e.g. reopening a Closed deal) instead of silently allowing them.
  // Unknown/legacy current statuses are left editable (not blocked).
  if (typeof updates.status === "string") {
    const STATUS_TRANSITIONS: Record<string, string[]> = {
      Active: ["Inactive", "Closed"],
      Inactive: ["Active", "Closed"],
      Closed: [],
    };
    const { data: current } = await supabase
      .from("deals")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    const from = (current?.status as string | null) ?? null;
    const to = updates.status;
    if (
      from &&
      from !== to &&
      from in STATUS_TRANSITIONS &&
      !STATUS_TRANSITIONS[from].includes(to)
    ) {
      return NextResponse.json(
        { success: false, error: `Cannot change deal status from ${from} to ${to}` },
        { status: 400 },
      );
    }
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
    // GAP-017: enforce the same format bulk import uses. Tolerate an UNCHANGED
    // legacy value so editing other fields on an older deal isn't blocked — only
    // a new/changed file number must match.
    if (!FILE_NUMBER_REGEX.test(trimmed)) {
      const { data: cur } = await supabase
        .from("deals")
        .select("file_number")
        .eq("id", id)
        .maybeSingle();
      if (cur?.file_number !== trimmed) {
        return NextResponse.json(
          { success: false, error: FILE_NUMBER_HINT },
          { status: 400 },
        );
      }
    }
  }

  // GAP-001: optimistic concurrency. The client may send `expected_updated_at`
  // (the deal's updated_at when it was loaded). We stamp a fresh updated_at on
  // every edit and, when the client supplied one, only update the row if its
  // updated_at still matches — so if someone else saved in the meantime, this
  // update matches 0 rows and we return 409 instead of silently overwriting.
  // Omitting the field keeps the old last-write-wins behaviour (backward-compat).
  const expectedUpdatedAt =
    typeof (body as any).expected_updated_at === "string"
      ? (body as any).expected_updated_at
      : null;
  updates.updated_at = new Date().toISOString();
  // Stamp the note's own edit time (Last updated column); cleared with the note.
  if ("admin_note" in updates) {
    updates.admin_note_updated_at = updates.admin_note ? updates.updated_at : null;
  }

  let updateQuery = supabase.from("deals").update(updates).eq("id", id);
  if (expectedUpdatedAt) {
    updateQuery = updateQuery.eq("updated_at", expectedUpdatedAt);
  }
  const { data, error } = await updateQuery.select().single();

  if (error) {
    // 0 rows with an expected_updated_at set == a concurrent edit moved it.
    if (expectedUpdatedAt && error.code === "PGRST116") {
      return NextResponse.json(
        {
          success: false,
          conflict: true,
          error:
            "This deal was changed by someone else since you opened it. Reload and re-apply your changes.",
        },
        { status: 409 },
      );
    }
    const friendly =
      error.code === "23505"
        ? "File number already in use"
        : error.message;
    return NextResponse.json(
      { success: false, error: friendly },
      { status: 400 },
    );
  }

  // Mirror file-level fields across every linked co-purchaser/co-seller deal
  // so a family file stays in sync. Non-blocking: a mirror failure shouldn't
  // roll back the primary update (which the admin can see succeeded).
  let mirroredCount = 0;
  try {
    const mirrorPayload: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (MIRROR_DEAL_COLUMNS.has(key)) mirrorPayload[key] = value;
    }

    if (Object.keys(mirrorPayload).length > 0) {
      const familyDealIds = await getFamilyDealIds(id);
      const siblingIds = familyDealIds.filter((d) => d !== id);
      if (siblingIds.length > 0) {
        const { data: mirrored } = await supabase
          .from("deals")
          .update(mirrorPayload)
          .in("id", siblingIds)
          .select("id");
        mirroredCount = mirrored?.length ?? 0;
      }
    }
  } catch (mirrorErr) {
    console.error("[admin/deals PATCH] mirror to family failed (non-blocking):", mirrorErr);
  }

  return NextResponse.json({ success: true, data, mirrored: mirroredCount });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid deal id" }, { status: 400 });
  }

  // Soft delete: flag the deal as is_deleted so it disappears from the admin
  // lists and every customer access gate, but the row (and all its tasks,
  // milestones, responses, signatures) stay intact. Reversible with
  // `UPDATE deals SET is_deleted=false`.
  const { error } = await supabase
    .from("deals")
    .update({ is_deleted: true })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  // SEC-006 / CMP-004: record who deleted which deal.
  const actor = await getActingAdmin();
  await recordAudit({
    action: "deal.delete",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "deal",
    resourceId: id,
    req,
  });

  return NextResponse.json({ success: true });
}
