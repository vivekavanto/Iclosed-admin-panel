// Address fields on a task form are plain `text` rows, so they are matched by
// label — keep in sync with the portal's addressValidation.ts.

// Anchored on "street" so it can't match "Email Address".
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

export function isUnitField(label: string | null | undefined): boolean {
  return /\b(unit|apartment|apt|suite)\b/i.test(label ?? "");
}

// The Purchase-side "Mail address same as purchase property" checkbox.
export function isMailSameAsPropertyField(label: string | null | undefined): boolean {
  return /mail address same as/i.test(label ?? "");
}

// Canadian postal code (A1A 1A1) as typed: uppercases, drops characters in the
// wrong position-class, spaces after the 3rd. Caps at 6 alphanumerics.
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
