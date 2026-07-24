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
  /**
   * Authoritative co-client side recorded at intake ("purchaser" | "seller").
   * Preferred over the lead_type / address heuristic because that heuristic
   * can't tell purchaser from seller on a Purchase & Sale parent where both
   * co-leads share both addresses (see getCoRole in components/Leads.tsx).
   */
  co_person_role?: string | null;
  address_street?: string | null;
  address_city?: string | null;
  address_province?: string | null;
  address_postal_code?: string | null;
  selling_address_street?: string | null;
  selling_address_city?: string | null;
  selling_address_province?: string | null;
  selling_address_postal_code?: string | null;
};

export type LeadAddressParts = {
  /** Joined purchase address (street, city, province, postal) or "" if none. */
  purchase: string;
  /** Joined selling address (street, city, province, postal) or "" if none. */
  selling: string;
  /** True if the lead represents a combined Purchase & Sale transaction. */
  treatAsCombined: boolean;
  /** True if the lead is sale-only (not combined). */
  typeIsSaleOnly: boolean;
  /** The address side this recipient should see. Primaries can see both. */
  recipientSide: "purchase" | "sale" | "combined";
};

function inferCoLeadSide(
  lead: LeadAddressFields,
  rawType: string,
  purchase: string,
  selling: string,
): "purchase" | "sale" {
  // Authoritative side recorded at intake wins over every heuristic below.
  const coPersonRole = (lead.co_person_role ?? "").toLowerCase().trim();
  if (coPersonRole === "purchaser") return "purchase";
  if (coPersonRole === "seller") return "sale";

  const typeIsCombined = rawType.includes("purchase") && rawType.includes("sale");
  const typeIsSaleOnly = !typeIsCombined && rawType.includes("sale");

  if (typeIsSaleOnly) return "sale";
  if (rawType.includes("purchase") && !rawType.includes("sale")) return "purchase";
  if (typeIsCombined && selling && !purchase) return "sale";
  if (typeIsCombined && purchase && !selling) return "purchase";
  if (lead.selling_address_street && !lead.address_street) return "sale";
  if (selling && !purchase) return "sale";
  return "purchase";
}

/**
 * Returns the underlying purchase / selling address pieces used to render
 * email placeholders. {@link buildLeadAddressForEmail} composes these into a
 * single line; templates that need to render the two sides separately
 * (e.g. "Purchase of X and Sale of Y") should use this helper instead.
 */
export async function buildLeadAddressPartsForEmail(
  lead: LeadAddressFields | null | undefined,
): Promise<LeadAddressParts> {
  if (!lead) {
    return {
      purchase: "",
      selling: "",
      treatAsCombined: false,
      typeIsSaleOnly: false,
      recipientSide: "purchase",
    };
  }

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

  if (lead.parent_lead_id) {
    const recipientSide = inferCoLeadSide(lead, rawType, purchase, selling);

    // Co-leads frequently don't carry the property address on their own row —
    // it lives on the root lead — so pull the family's addresses to backfill.
    // NOTE: for a Sale-ONLY family the sold property is stored in the generic
    // address_* columns; selling_address_* is only populated for the Sale side
    // of a *combined* Purchase & Sale file. So the Sale side must fall back to
    // address_* when NO selling_address_* exists anywhere in the family —
    // otherwise a co-seller's email renders a blank address (and a blank
    // "Sale of …" phrase) even though the primary renders fine via the same
    // address_* fallback used in the non-co-lead branch below.
    let familyPurchase = "";
    let familySelling = "";
    {
      const rootLeadId = lead.parent_lead_id;
      const { data: family } = await supabaseAdmin
        .from("leads")
        .select(
          "id, parent_lead_id, lead_type, address_street, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code",
        )
        .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

      for (const sib of family ?? []) {
        if (!familyPurchase) {
          const candidate = joinAddress([
            sib.address_street,
            sib.address_city,
            sib.address_province,
            sib.address_postal_code,
          ]);
          if (candidate) familyPurchase = candidate;
        }
        if (!familySelling) {
          const candidate = joinAddress([
            sib.selling_address_street,
            sib.selling_address_city,
            sib.selling_address_province,
            sib.selling_address_postal_code,
          ]);
          if (candidate) familySelling = candidate;
        }
        if (familyPurchase && familySelling) break;
      }
    }

    if (recipientSide === "purchase") {
      return {
        purchase: purchase || familyPurchase,
        selling: "",
        treatAsCombined: false,
        typeIsSaleOnly: false,
        recipientSide,
      };
    }

    // recipientSide === "sale": prefer a dedicated selling_address_* (own, then
    // family); only when the whole family has none (a pure Sale file) does the
    // sold property live in the generic address_* columns, so fall back to
    // those last. familySelling being present on a *combined* file means the
    // address_* fallback never fires there (address_* is the purchase side).
    const saleAddr = selling || familySelling || purchase || familyPurchase;
    return {
      purchase: "",
      selling: saleAddr,
      treatAsCombined: false,
      typeIsSaleOnly: true,
      recipientSide,
    };
  }

  let treatAsCombined = typeIsCombined || (!!purchase && !!selling);

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

  return {
    purchase,
    selling,
    treatAsCombined,
    typeIsSaleOnly,
    recipientSide: treatAsCombined ? "combined" : typeIsSaleOnly ? "sale" : "purchase",
  };
}

/**
 * Render a transaction phrase that pairs each address with its correct
 * side, e.g.
 *   • Combined → "Purchase of <P> and Sale of <S>"
 *   • Sale-only → "Sale of <S>"
 *   • Purchase / other → "<Type> of <P>"
 *
 * This is what replaces the legacy "{{ lead_type }} of {{ lead_address }}"
 * pattern in email templates so combined Purchase & Sale files no longer
 * read as "Purchase & Sale of X and Y" (which collapses the two sides).
 */
export function renderTransactionPhrase(
  parts: LeadAddressParts,
  leadTypeLabel: string,
): string {
  const { purchase, selling, treatAsCombined, typeIsSaleOnly } = parts;
  if (treatAsCombined && purchase && selling) {
    return `Purchase of ${purchase} and Sale of ${selling}`;
  }
  if (treatAsCombined) {
    // Only one side known — fall back to whichever exists with its label.
    if (purchase) return `Purchase of ${purchase}`;
    if (selling) return `Sale of ${selling}`;
    return "";
  }
  if (typeIsSaleOnly) {
    return selling ? `Sale of ${selling}` : (purchase ? `Sale of ${purchase}` : "");
  }
  const addr = purchase || selling;
  if (!addr) return "";
  if (leadTypeLabel.toLowerCase().includes("purchase") && leadTypeLabel.toLowerCase().includes("sale")) {
    return `Purchase of ${addr}`;
  }
  return leadTypeLabel ? `${leadTypeLabel} of ${addr}` : addr;
}

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
  const { purchase, selling, treatAsCombined, typeIsSaleOnly } =
    await buildLeadAddressPartsForEmail(lead);

  return treatAsCombined
    ? [purchase, selling].filter(Boolean).join(" and ")
    : typeIsSaleOnly
      ? (selling || purchase)
      : purchase;
}
