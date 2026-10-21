import type {User} from "@supabase/supabase-js";
// Match the existing dev-branch admin middleware without broadening access.
export function canAccessOperations(user:User|null|undefined){return user?.app_metadata?.role==="admin";}
