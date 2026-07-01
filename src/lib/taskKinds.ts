/**
 * Identifies the two per-party tasks (Personal Information / Upload
 * Identification) that, on a deal with a co-purchaser/co-seller, are filled per
 * person and shown complete only when every involved party's section is done.
 *
 * Detection is by title (case-insensitive substring), matching the customer
 * portal (D:\iclosed_dev_web\src\lib\taskKinds.ts) so both apps agree on what
 * counts as a per-party task and open the same multi-party accordion.
 */

export function isPersonalInfoTask(title: string | null | undefined): boolean {
  return (title ?? "").toLowerCase().includes("provide personal information");
}

export function isUploadIdTask(title: string | null | undefined): boolean {
  return (title ?? "").toLowerCase().includes("upload identification");
}

export function isPerPartyTask(title: string | null | undefined): boolean {
  return isPersonalInfoTask(title) || isUploadIdTask(title);
}

/** Number of verified IDs a party must upload (the drawer enforces "two verified IDs"). */
export const REQUIRED_ID_DOCS = 2;
