import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { getOwner } from "@/lib/staffServer";
import { MODULES, isCompanyEmail, isOwner, assignedModuleIds } from "@/lib/staffAccess";
export async function GET(request: Request) {
  if (!await getOwner()) return NextResponse.json({ error: "Owner access required." }, { status: 403 });
  const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
  if (!Number.isInteger(page) || page < 1) return NextResponse.json({ error: "Invalid page." }, { status: 400 });
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
  if (error) return NextResponse.json({ error: "Could not load accounts." }, { status: 500 });
  return NextResponse.json({ users: data.users.filter(u => (u.email && isCompanyEmail(u.email)) || u.app_metadata.role === "admin").map(u => ({ id: u.id, email: u.email, verified: !!u.email_confirmed_at, owner: isOwner(u), disabled: u.app_metadata.staff_disabled === true || u.app_metadata.role === "inactive", modules: assignedModuleIds(u) })), nextPage: data.users.length === 100 ? page + 1 : null }, { headers: { "Cache-Control": "private, no-store" } });
}
export async function PATCH(request: Request) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Owner access required." }, { status: 403 });
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  if (!body || typeof body.id !== "string" || !Array.isArray(body.modules) || body.modules.some((id: unknown) => !MODULES.some(m => m.id === id)) || typeof body.disabled !== "boolean") return NextResponse.json({ error: "Invalid permissions." }, { status: 400 });
  const { data: { user }, error } = await supabaseAdmin.auth.admin.getUserById(body.id);
  if (error || !user) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  if (user.email?.toLowerCase() === "saru@navawilson.law") return NextResponse.json({ error: "The owner account cannot be changed here." }, { status: 400 });
  if ((!user.email || !isCompanyEmail(user.email)) && user.app_metadata.role !== "admin") return NextResponse.json({ error: "Only staff accounts can receive module access." }, { status: 400 });
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, ...(user.app_metadata.role === "inactive" && !body.disabled ? { role: "staff" } : {}), staff_modules: [...new Set(body.modules)], staff_disabled: body.disabled, staff_access_updated_by: owner.id, staff_access_updated_at: new Date().toISOString() } });
  if (updateError) return NextResponse.json({ error: "Could not save permissions." }, { status: 500 });
  await recordAudit({ action: "staff.access.update", actorEmail: owner.email, actorUserId: owner.id, resourceType: "user", resourceId: user.id, metadata: { previousModules: assignedModuleIds(user), modules: [...new Set(body.modules)], previousDisabled: user.app_metadata.staff_disabled === true, disabled: body.disabled }, req: request });
  return NextResponse.json({ success: true });
}
