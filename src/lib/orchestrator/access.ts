import type { User } from "@supabase/supabase-js";
import { hasModule } from "../staffAccess.ts";
export function canAccessOperations(user: User | null | undefined) {
  return hasModule(user, "legal-assistant");
}
