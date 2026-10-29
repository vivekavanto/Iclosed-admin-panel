import type { User } from "@supabase/supabase-js";

export const OWNER_EMAIL = "saru@navawilson.law";
export const MODULES = [
  { id: "legal-assistant", label: "Legal Assistant", path: "/admin/legal-assistant" },
  { id: "finance", label: "Finance", path: "/admin/finance" },
  { id: "dashboard", label: "Dashboard", path: "/admin/dashboard" },
  { id: "search", label: "Search", path: "/admin/search" },
  { id: "tasks", label: "Tasks", path: "/admin/tasks" },
  { id: "deals", label: "All Files", path: "/admin/deals" },
  { id: "calculator", label: "Calculator", path: "/closing-cost-calculator" },
  { id: "templates", label: "Templates", path: "/admin/templates" },
  { id: "leads", label: "Leads", path: "/admin/leads" },
  { id: "messages", label: "Messages", path: "/admin/messages" },
  { id: "blogs", label: "Blogs", path: "/admin/blogs" },
  { id: "partners", label: "Partners", path: "/admin/partners" },
  { id: "agent-portal", label: "Agent Portal", path: "/admin/agent-portal" },
  { id: "signing-appointments", label: "Signing Appointments", path: "/admin/settings/signing/appointments" },
  { id: "settings", label: "Settings", path: "/admin/settings" },
] as const;
export type ModuleId = typeof MODULES[number]["id"];
type Identity = Pick<User, "email" | "email_confirmed_at" | "app_metadata">;
export function isCompanyEmail(email: string): boolean {
  return /^[^\s@]+@(navawilson\.law|iclosed\.ca)$/i.test(email.trim());
}
export function canSignIn(user: Identity | null | undefined): boolean {
  if (!user || !user.email_confirmed_at || user.app_metadata.role === "inactive" || user.app_metadata.staff_disabled === true) return false;
  return user.app_metadata.role === "admin" || (!!user.email && isCompanyEmail(user.email));
}
export function isOwner(user: Identity | null | undefined): boolean {
  return canSignIn(user) && user?.email?.toLowerCase() === OWNER_EMAIL;
}
export function assignedModuleIds(user: Identity | null | undefined): ModuleId[] {
  if (!user) return [];
  if (user.email?.toLowerCase() === OWNER_EMAIL) return MODULES.map(m => m.id);
  // Existing admins retain their current modules until the owner explicitly scopes them.
  if (!Object.hasOwn(user.app_metadata, "staff_modules") && user.app_metadata.role === "admin") return MODULES.map(m => m.id);
  const assigned: unknown = user.app_metadata.staff_modules;
  return Array.isArray(assigned) ? MODULES.filter(m => assigned.includes(m.id)).map(m => m.id) : [];
}
export function moduleIds(user: Identity | null | undefined): ModuleId[] {
  return canSignIn(user) ? assignedModuleIds(user) : [];
}
export function hasModule(user: Identity | null | undefined, id: string): boolean {
  if (id === "staff" || id === "access") return isOwner(user);
  return moduleIds(user).some(m => m === id);
}
export function homePath(user: Identity | null | undefined): string {
  if (isOwner(user)) return "/admin/dashboard";
  return MODULES.find(m => m.id !== "search" && hasModule(user, m.id))?.path ?? "/admin/welcome";
}
const within = (p: string, root: string) => p === root || p.startsWith(root + "/");
export function requiredModules(path: string, method = "GET"): string[] {
  if (within(path, "/api/admin/access") || within(path, "/admin/access") || within(path, "/api/admin/users") || within(path, "/admin/users") || within(path, "/api/admin/account")) return ["owner"];
  if (within(path, "/api/admin/legal-assistant") || within(path, "/admin/legal-assistant")) return ["legal-assistant"];
  if (within(path, "/api/admin/finance") || within(path, "/admin/finance")) return ["finance"];
  if (within(path, "/admin/settings/signing/appointments") || within(path, "/api/admin/signing/appointments")) return ["signing-appointments", "settings"];
  if (["GET", "HEAD"].includes(method.toUpperCase()) && within(path, "/api/admin/signing")) return ["settings", "deals", "signing-appointments"];
  if (within(path, "/admin/settings") || within(path, "/api/admin/signing") || within(path, "/api/admin/closing-cost-config")) return ["settings"];
  if (within(path, "/api/admin/blog") || within(path, "/admin/blogs")) return ["blogs"];
  if (within(path, "/api/admin/messages") || within(path, "/admin/messages")) return ["messages"];
  if (within(path, "/api/admin/partners") || within(path, "/admin/partners")) return ["partners"];
  // New staff tracking writes require the same grant as task/file writes.
  if (/^\/api\/admin\/agent-portal\/[^/]+\/files\/[^/]+\/journey(?:\/|$)/.test(path)) return ["tasks", "deals"];
  if (within(path, "/api/admin/agent-portal") || within(path, "/admin/agent-portal")) return ["agent-portal", "partners"];
  if (within(path, "/admin/templates")) return ["templates"];
  if (["email-templates", "milestone-templates", "task-templates", "task-form-fields"].some(x => within(path, "/api/admin/" + x))) {
    return ["GET", "HEAD"].includes(method.toUpperCase()) ? ["templates", "settings", "deals", "tasks", "leads"] : ["templates", "settings"];
  }
  if (within(path, "/api/admin/notifications/new-leads")) return ["leads"];
  if (within(path, "/api/admin/notifications")) return ["deals", "leads", "tasks", "dashboard"];
  if (within(path, "/admin/search")) return ["search"];
  if (within(path, "/admin/dashboard")) return ["dashboard"];
  if (within(path, "/admin/tasks")) return ["tasks"];
  if (within(path, "/admin/deals")) return ["deals"];
  if (within(path, "/admin/leads")) return ["leads"];
  // Supporting record reads are shared; a read-only view does not grant writes.
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    if (["deals", "clients", "milestones"].some(x => within(path, "/api/admin/" + x))) return ["deals"];
    if (["tasks", "task-responses", "task-responses-batch", "family-task-status"].some(x => within(path, "/api/admin/" + x))) return ["tasks", "deals"];
  }
  // Shared APIs return the same records used by these connected modules.
  if (["deals", "clients", "milestones", "tasks", "task-responses", "task-responses-batch", "family-task-status"].some(x => within(path, "/api/admin/" + x))) return ["deals", "tasks"];
  if (["leads", "lead-docs", "lead-identification-docs", "convert-lead", "staff-intake-link", "retainer-status", "send-retainer-link"].some(x => within(path, "/api/admin/" + x))) return ["leads", "deals"];
  if (["documents", "uploadblobstorage", "identify-document", "aps-uploaded"].some(x => within(path, "/api/admin/" + x))) return ["deals", "leads"];
  // Maintenance, impersonation and any unclassified endpoint are owner-only.
  return ["owner"];
}
export function canVisit(user: Identity | null | undefined, path: string, method = "GET"): boolean {
  if (!canSignIn(user)) return false;
  if (["/admin/welcome", "/admin/change-password", "/admin/account-settings"].includes(path)) return true;
  const required = requiredModules(path, method);
  if (required.includes("owner")) return isOwner(user);
  return isOwner(user) || required.some(id => hasModule(user, id));
}
