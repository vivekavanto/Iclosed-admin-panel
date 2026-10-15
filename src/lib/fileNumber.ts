// Canonical file-number format, shared so bulk import and deal edit validate
// identically (GAP-017): two digits, 1-3 uppercase letters, a dash, then 3-5
// digits — e.g. "26AB-1234".
export const FILE_NUMBER_REGEX = /^[0-9]{2}[A-Z]{1,3}-[0-9]{3,5}$/;

export const FILE_NUMBER_HINT = "File number must look like 26AB-1234";

// Placeholder until the Tickler assigns the real number.
export const PENDING_FILE_NUMBER_PREFIX = "PENDING-";

export function pendingFileNumber(): string {
  return `${PENDING_FILE_NUMBER_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

export function isPendingFileNumber(value: string | null | undefined): boolean {
  return !!value && value.startsWith(PENDING_FILE_NUMBER_PREFIX);
}

export function displayFileNumber(value: string | null | undefined): string {
  return isPendingFileNumber(value) ? "File number pending" : (value ?? "");
}
