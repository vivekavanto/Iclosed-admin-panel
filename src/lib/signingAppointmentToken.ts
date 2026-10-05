// The reschedule/cancel link for a signing appointment.
//
// Deliberately NOT routed through `invitation_tokens` (see
// migrations/2026-10-01-signing-appointments.sql header): that table is
// consumption-capped and auth-adjacent, which is wrong for a link a client
// may reopen indefinitely with no auth-session semantics. Instead each
// signing_appointments row carries its own `manage_token`, generated once at
// booking time and never rotated — shaped like finalReportLink.ts's
// scoped-lookup pattern (a token resolves to exactly one record and nothing
// else) but independent of the shared table.

import { randomBytes } from "crypto";
import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";

export function generateManageToken(): string {
  return randomBytes(24).toString("base64url");
}

export const SIGNING_MANAGE_PATH = "/signing/manage";

function resolveBaseUrl(): string {
  // Same convention as invitationToken.ts: explicit env var, falling back to
  // the stable production admin URL rather than VERCEL_URL (which changes
  // per-deployment) or localhost (dead for a recipient outside dev).
  const explicit = process.env.NEXT_PUBLIC_ADMIN_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  return "https://iclosed-admin-panel.vercel.app";
}

export function buildManageUrl(token: string): string {
  return `${resolveBaseUrl()}${SIGNING_MANAGE_PATH}/${token}`;
}

export interface SigningAppointmentRow {
  id: string;
  lawyer_id: string;
  status: "confirmed" | "cancelled";
  start_at: string;
  end_at: string;
  appointment_type: "virtual" | "in_person";
  deal_type: "purchase" | "sale" | null;
  client_name: string;
  client_email: string;
  client_phone: string | null;
  property_address: string | null;
  closing_date: string | null;
  file_number: string | null;
  extra_guests: string[];
  extra_cohosts: string[];
  google_event_id: string | null;
  google_meet_link: string | null;
  manage_token: string | null;
  lead_id: string | null;
  deal_id: string | null;
  created_by: string | null;
}

export async function resolveAppointmentByToken(
  token: string,
): Promise<SigningAppointmentRow | null> {
  if (!token) return null;
  const { data, error } = await supabaseAdmin
    .from("signing_appointments")
    .select("*")
    .eq("manage_token", token)
    .maybeSingle();
  if (error) {
    logger.error("[signingAppointmentToken] resolve failed:", error.message);
    return null;
  }
  return (data as SigningAppointmentRow | null) ?? null;
}
