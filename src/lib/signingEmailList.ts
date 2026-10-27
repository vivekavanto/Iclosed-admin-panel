// Parses the comma-separated CC list the admin types into the signing settings.
// No imports on purpose: the settings form is a client component, so this file
// must not pull in the server-only Supabase client that signingConfig.ts uses.

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Splits on commas, semicolons or whitespace; lowercases and de-duplicates. */
export function parseEmailList(value: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of String(value ?? "").split(/[,;\s]+/)) {
    const email = raw.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return Array.from(seen);
}
