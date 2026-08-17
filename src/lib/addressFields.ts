/**
 * Label matchers for the address fields on a dynamic task form. Form fields
 * are stored as plain `text` rows in `task_form_fields`, so street / city /
 * postal are identified by their label — the same way the customer portal
 * does it (`src/lib/addressValidation.ts` in `iclosed-customer-application`).
 * Keep the two in sync: a label the portal treats as an address field must
 * match here too, or the admin form fills the wrong sibling.
 */

// Matches "Street Address" / "Mailing street address". Anchored on "street"
// so it can't match "Email Address".
export function isStreetAddressField(label: string | null | undefined): boolean {
  const l = (label ?? "").trim().toLowerCase();
  return /\bstreet\s*address\b/.test(l) || l === "street";
}

export function isCityField(label: string | null | undefined): boolean {
  return /\bcity\b/i.test(label ?? "");
}

export function isPostalCodeField(label: string | null | undefined): boolean {
  return /postal|zip/i.test(label ?? "");
}

// Canadian postal code (A1A 1A1) as typed: uppercases, drops characters in the
// wrong position-class (letter vs digit), inserts the space after the 3rd.
// Already-formatted input is a no-op. Caps at 6 alphanumerics.
export function formatPostalCode(raw: string): string {
  const positions = ["L", "D", "L", "D", "L", "D"] as const;
  const valid: string[] = [];
  for (const c of raw.toUpperCase()) {
    if (valid.length >= 6) break;
    if (!/[A-Z0-9]/.test(c)) continue;
    const expected = positions[valid.length];
    if ((expected === "L" && /[A-Z]/.test(c)) || (expected === "D" && /[0-9]/.test(c))) {
      valid.push(c);
    }
  }
  if (valid.length <= 3) return valid.join("");
  return `${valid.slice(0, 3).join("")} ${valid.slice(3).join("")}`;
}
