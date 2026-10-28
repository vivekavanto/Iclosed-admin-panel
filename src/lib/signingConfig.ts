// Reads/writes for the signing-appointment configuration tables
// (signing_lawyers, signing_lawyer_hours, signing_settings). Shared by the
// admin CRUD routes and the public availability/booking routes so both read
// the same rows.

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { parseEmailList } from "./signingEmailList";

export interface SigningLawyer {
  id: string;
  initials: string;
  full_name: string;
  email: string;
  calendar_id: string;
  is_active: boolean;
  // Absent before the 2026-10-28 migration: reads then keep the old behaviour.
  hours_mode?: SigningHoursMode;
  created_at: string;
  updated_at: string;
}

/** `default`: one schedule for everything. `custom`: Purchase/Sale have their own and the default is not used for them. */
export type SigningHoursMode = "default" | "custom";

export function normalizeHoursMode(value: unknown): SigningHoursMode | null {
  return value === "default" || value === "custom" ? value : null;
}

/** Deal types that can carry their own weekly schedule. Refinance has none: it uses the default. */
export type SigningHoursType = "purchase" | "sale";

export function normalizeHoursType(value: unknown): SigningHoursType | null {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "purchase" || v === "sale" ? v : null;
}

export interface SigningLawyerHours {
  id: string;
  lawyer_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  // NULL/absent = the default schedule (also what every row is before the
  // 2026-10-27 migration, when the column does not exist yet).
  deal_type?: SigningHoursType | null;
}

export interface SigningSettings {
  id: string;
  default_duration_minutes: number;
  buffer_minutes: number;
  slot_increment_minutes: number;
  office_address: string;
  // The CC list: one comma-separated string. Older rows also kept a separate
  // reception address; getSettings folds that into this field.
  clerk_email: string;
  reception_email: string;
  // Added to every signing event as an OPTIONAL attendee. "" = nobody.
  optional_guest_email: string;
  disclaimer_text: string;
  // Initials of the signing_lawyers calendar clients see unless a file
  // overrides it with deals.signing_with. NULL = not chosen yet.
  default_signing_with: string | null;
  // A signing must be booked at least this many business days before closing.
  // 0 = no restriction.
  min_business_days_before_closing: number;
  // ...and no earlier than this many business days before closing, so the
  // bookable window is [closing - max, closing - min]. 0 = no limit.
  max_business_days_before_closing: number;
}

export async function listLawyers(opts?: { activeOnly?: boolean }): Promise<SigningLawyer[]> {
  let query = supabaseAdmin.from("signing_lawyers").select("*").order("initials");
  if (opts?.activeOnly) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) {
    logger.error("[signingConfig] listLawyers failed:", error.message);
    return [];
  }
  return (data ?? []) as SigningLawyer[];
}

export async function getLawyerByInitials(initials: string): Promise<SigningLawyer | null> {
  const { data, error } = await supabaseAdmin
    .from("signing_lawyers")
    .select("*")
    .ilike("initials", initials)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    logger.error("[signingConfig] getLawyerByInitials failed:", error.message);
    return null;
  }
  return (data as SigningLawyer | null) ?? null;
}

export async function getLawyerById(id: string): Promise<SigningLawyer | null> {
  const { data, error } = await supabaseAdmin
    .from("signing_lawyers")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logger.error("[signingConfig] getLawyerById failed:", error.message);
    return null;
  }
  return (data as SigningLawyer | null) ?? null;
}

// select("*") + filtering in code (rather than .eq("deal_type", ...)) keeps every
// read working before the deal_type migration is applied.
export async function listAllLawyerHours(lawyerId: string): Promise<SigningLawyerHours[]> {
  const { data, error } = await supabaseAdmin
    .from("signing_lawyer_hours")
    .select("*")
    .eq("lawyer_id", lawyerId)
    .order("day_of_week");
  if (error) {
    logger.error("[signingConfig] getLawyerHours failed:", error.message);
    return [];
  }
  return (data ?? []) as SigningLawyerHours[];
}

/**
 * The schedule that applies to a booking of `dealType`.
 *  - default mode: always the default rows (Purchase/Sale rows are ignored).
 *  - custom mode: a purchase/sale booking gets ONLY that type's rows, so a side
 *    with none has no availability. Refinance / no type still uses the default rows.
 *  - mode unknown (pre-migration): that type's own rows if any, else default.
 */
export async function getLawyerHours(
  lawyerId: string,
  dealType: SigningHoursType | null = null,
): Promise<SigningLawyerHours[]> {
  const [rows, lawyer] = await Promise.all([listAllLawyerHours(lawyerId), getLawyerById(lawyerId)]);
  const defaults = rows.filter((r) => !r.deal_type);
  if (!dealType) return defaults;
  const own = rows.filter((r) => r.deal_type === dealType);
  const mode = lawyer?.hours_mode;
  if (mode === "default") return defaults;
  if (mode === "custom") return own;
  return own.length > 0 ? own : defaults;
}

/** True once the lawyer has saved any schedule at all (default, purchase or sale). */
export async function lawyerHasAnyHours(lawyerId: string): Promise<boolean> {
  return (await listAllLawyerHours(lawyerId)).length > 0;
}

/** Only the rows saved for exactly this schedule (null = default), with no fallback. For the admin editor. */
export async function getLawyerHoursExact(
  lawyerId: string,
  dealType: SigningHoursType | null,
): Promise<SigningLawyerHours[]> {
  const rows = await listAllLawyerHours(lawyerId);
  return rows.filter((r) => (r.deal_type ?? null) === dealType);
}

const DEFAULT_SETTINGS: Omit<SigningSettings, "id"> = {
  // 45-min appointments on a 30-min grid: booking 10:00 occupies 10:00-10:45,
  // so 10:30 is taken and the next open start is 11:00. The grid gap already
  // covers turnaround, hence no buffer.
  default_duration_minutes: 45,
  buffer_minutes: 0,
  slot_increment_minutes: 30,
  office_address: "10 Milner Business Court Scarborough, ON M1B 3C6",
  clerk_email: "Marcela@navawilson.law",
  reception_email: "reception@navawilson.law",
  optional_guest_email: "",
  default_signing_with: null,
  min_business_days_before_closing: 1,
  max_business_days_before_closing: 3,
  disclaimer_text:
    "Please schedule your signing appointment 1-3 business days before your closing date. Note: Appointments are subject to our office receiving the required mortgage instructions (for purchases) and payout statement (for sales). If the required documents are not received in time, your appointment may need to be rescheduled.",
};

/**
 * The admin edits one CC list. Clerk and reception used to be two inputs, so
 * fold any reception address into clerk_email and blank reception_email; the
 * attendee list then reads a single field whatever the row looked like.
 */
function withSingleCcList(settings: SigningSettings): SigningSettings {
  const ccList = parseEmailList([settings.clerk_email, settings.reception_email].join(","));
  return { ...settings, clerk_email: ccList.join(", "), reception_email: "" };
}

/** The single settings row, falling back to code defaults pre-migration. */
export async function getSettings(): Promise<SigningSettings> {
  const { data, error } = await supabaseAdmin
    .from("signing_settings")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error("[signingConfig] getSettings failed:", error.message);
    return withSingleCcList({ id: "", ...DEFAULT_SETTINGS });
  }
  if (!data) return withSingleCcList({ id: "", ...DEFAULT_SETTINGS });
  // Merge onto the defaults rather than returning the row as-is: a column
  // added by a migration that hasn't been applied to this database yet (see
  // CLAUDE.md — migrations are never auto-run) is simply absent from the row,
  // which must fail CLOSED to the safe default rather than silently reading as
  // "no restriction" (min/max business days <= 0 turns the cutoff rule off).
  const merged = { ...DEFAULT_SETTINGS, ...(data as Partial<SigningSettings>), id: (data as { id: string }).id } as SigningSettings;
  return withSingleCcList(merged);
}
