import supabaseAdmin from "./supabaseAdmin";

/**
 * Shared helpers used by every outbound email path so all templates render
 * the {{ lead_type }} and {{ lead_address }} placeholders consistently.
 *
 * Why this exists:
 *   • The lead_type column is stored mixed-case ("Purchase & Sale") in some
 *     rows and lowercase in others — emails were lowercasing it which made
 *     "Purchase" and "Sale" read poorly. We always render with proper case.
 *   • Combined Purchase & Sale files have TWO addresses (purchase + selling)
 *     and emails used to surface only the purchase one. We now combine them
 *     into "<purchase> and <selling>". When a family splits the two sides
 *     across sibling leads (primary holds the purchase, co-lead holds the
 *     sale, or vice-versa), we pick up the missing side from the family.
 */

export function formatLeadTypeLabel(rawType: string | null | undefined): string {
  const lt = (rawType ?? "").toLowerCase().trim();
  if (lt.includes("purchase") && lt.includes("sale")) return "Purchase & Sale";
  if (lt === "sale" || (lt.includes("sale") && !lt.includes("purchase"))) return "Sale";
  if (lt === "purchase") return "Purchase";
  if (lt === "refinance") return "Refinance";
  return (rawType ?? "").trim();
}

function joinAddress(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(", ");
}

type LeadAddressFields = {
  id?: string | null;
  parent_lead_id?: string | null;
  lead_type?: string | null;
  address_street?: string | null;
  address_city?: string | null;
  address_province?: string | null;
  address_postal_code?: string | null;
  selling_address_street?: string | null;
  selling_address_city?: string | null;
  selling_address_province?: string | null;
  selling_address_postal_code?: string | null;
};

/**
 * Render the address line for a lead's email. For combined Purchase & Sale
 * leads, returns "<purchase address> and <selling address>".
 *
 * The "is this a P&S transaction?" decision is intentionally NOT driven by
 * this single lead row's `lead_type` alone. Intake often splits a P&S family
 * across siblings — e.g. primary lead_type="Purchase" + co-lead lead_type=
 * "Sale" — even though the deal is "Purchase & Sale". Trusting only
 * `lead_type` made emails to those co-leads render just one side. So we now
 * detect P&S from any of three signals:
 *   1. This lead's own lead_type contains both purchase + sale
 *   2. Both addresses are already populated on THIS row
 *   3. The family (root + siblings) has any "Purchase & Sale" sibling, OR
 *      has at least one purchase address AND one selling address across rows
 *
 * Family rows are also scanned to backfill whichever side is missing on the
 * passed-in lead so the combined "<purchase> and <selling>" line is always
 * complete when the data exists somewhere in the family.
 */
export async function buildLeadAddressForEmail(
  lead: LeadAddressFields | null | undefined,
): Promise<string> {
  if (!lead) return "";

  const rawType = (lead.lead_type ?? "").toLowerCase().trim();
  const typeIsCombined = rawType.includes("purchase") && rawType.includes("sale");
  const typeIsSaleOnly = !typeIsCombined && rawType.includes("sale");

  let purchase = joinAddress([
    lead.address_street,
    lead.address_city,
    lead.address_province,
    lead.address_postal_code,
  ]);
  let selling = joinAddress([
    lead.selling_address_street,
    lead.selling_address_city,
    lead.selling_address_province,
    lead.selling_address_postal_code,
  ]);

  // Signal 1+2: combined per lead_type, OR both addresses already on this row.
  let treatAsCombined = typeIsCombined || (!!purchase && !!selling);

  // Fetch family if we either still don't know whether it's combined, OR we
  // do know but need to backfill a missing side. One query covers both needs.
  const needsFamilyLookup =
    lead.id !== undefined && lead.id !== null &&
    (!treatAsCombined || !purchase || !selling);

  if (needsFamilyLookup && lead.id) {
    const rootLeadId = lead.parent_lead_id ?? lead.id;
    const { data: family } = await supabaseAdmin
      .from("leads")
      .select(
        "id, parent_lead_id, lead_type, address_street, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code",
      )
      .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

    if (family && family.length > 0) {
      // Signal 3: detect P&S from the family if we haven't already.
      if (!treatAsCombined) {
        const familyHasCombinedSibling = family.some((s) => {
          const t = (s.lead_type ?? "").toLowerCase();
          return t.includes("purchase") && t.includes("sale");
        });
        const familyHasPurchaseAddr = family.some((s) =>
          !!joinAddress([
            s.address_street,
            s.address_city,
            s.address_province,
            s.address_postal_code,
          ]),
        );
        const familyHasSellingAddr = family.some((s) =>
          !!joinAddress([
            s.selling_address_street,
            s.selling_address_city,
            s.selling_address_province,
            s.selling_address_postal_code,
          ]),
        );
        if (
          familyHasCombinedSibling ||
          (familyHasPurchaseAddr && familyHasSellingAddr)
        ) {
          treatAsCombined = true;
        }
      }

      // Backfill missing side(s) from family. Runs for both combined and
      // sale-only leads — the latter preserves the original behavior.
      const wantsBackfill = treatAsCombined || (typeIsSaleOnly && !selling);
      if (wantsBackfill) {
        for (const sib of family) {
          if (!purchase) {
            const candidate = joinAddress([
              sib.address_street,
              sib.address_city,
              sib.address_province,
              sib.address_postal_code,
            ]);
            if (candidate) purchase = candidate;
          }
          if (!selling) {
            const candidate = joinAddress([
              sib.selling_address_street,
              sib.selling_address_city,
              sib.selling_address_province,
              sib.selling_address_postal_code,
            ]);
            if (candidate) selling = candidate;
          }
          if (purchase && selling) break;
        }
      }
    }
  }

  const finalOutput = treatAsCombined
    ? [purchase, selling].filter(Boolean).join(" and ")
    : typeIsSaleOnly
      ? (selling || purchase)
      : purchase;

  // TEMP debug — remove once verified the fix is live.
  console.log("[buildLeadAddressForEmail]", {
    leadId: lead.id,
    leadType: lead.lead_type,
    rowPurchase: purchase,
    rowSelling: selling,
    treatAsCombined,
    typeIsSaleOnly,
    finalOutput,
  });

  return finalOutput;
}
