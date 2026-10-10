// Reads/writes for the signing-appointment configuration tables
// (signing_lawyers, signing_lawyer_hours, signing_settings). Shared by the
// admin CRUD routes and the public availability/booking routes so both read
// the same rows.

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";

export interface SigningLawyer {
  id: string;
  initials: string;
  full_name: string;
  email: string;
  calendar_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SigningLawyerHours {
  id: string;
  lawyer_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

export interface SigningSettings {
  id: string;
  default_duration_minutes: number;
  buffer_minutes: number;
  slot_increment_minutes: number;
  office_address: string;
  clerk_email: string;
  reception_email: string;
  disclaimer_text: string;
  // Initials of the signing_lawyers calendar clients see unless a file
  // overrides it with deals.signing_with. NULL = not chosen yet.
  default_signing_with: string | null;
  // A signing must be booked at least this many business days before closing.
  // 0 = no restriction.
  min_business_days_before_closing: number;
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

export async function getLawyerHours(lawyerId: string): Promise<SigningLawyerHours[]> {
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
  default_signing_with: null,
  min_business_days_before_closing: 3,
  disclaimer_text:
    "Please schedule your signing appointment 1-3 business days before your closing date. Note: Appointments are subject to our office receiving the required mortgage instructions (for purchases) and payout statement (for sales). If the required documents are not received in time, your appointment may need to be rescheduled.",
};

/** The single settings row, falling back to code defaults pre-migration. */
export async function getSettings(): Promise<SigningSettings> {
  const { data, error } = await supabaseAdmin
    .from("signing_settings")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.error("[signingConfig] getSettings failed:", error.message);
    return { id: "", ...DEFAULT_SETTINGS };
  }
  if (!data) return { id: "", ...DEFAULT_SETTINGS };
  return data as SigningSettings;
}
