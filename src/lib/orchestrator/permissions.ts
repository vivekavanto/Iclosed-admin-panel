import { canAccessOperations } from "./access.ts";
import type { User } from "@supabase/supabase-js";

export const INITIAL_ADMIN_EMAILS = ["saru@navawilson.law", "aliya@navawilson.law", "kubes@navawilson.law"];
export function canManageOrchestrator(user: User | null | undefined) {
  if (!canAccessOperations(user)) return false;
  return user?.app_metadata?.role === "admin" || (Array.isArray(user?.app_metadata?.permissions) && user.app_metadata.permissions.includes("orchestrator.manage")) ||
    (!!user?.email_confirmed_at && INITIAL_ADMIN_EMAILS.includes(user.email?.trim().toLowerCase() ?? ""));
}
