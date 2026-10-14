import { NextResponse } from "next/server";
import { signStaffIntakeToken } from "@/lib/staffIntakeToken";

export const dynamic = "force-dynamic";

/** GET /api/admin/staff-intake-link: the portal intake URL for a staff-filled intake. */
export async function GET() {
  const portal = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "").trim().replace(/\/+$/, "");
  if (!portal) {
    return NextResponse.json(
      { success: false, error: "NEXT_PUBLIC_CUSTOMER_PORTAL_URL is not set" },
      { status: 500 },
    );
  }
  const url = `${portal}/intake?staff=${encodeURIComponent(signStaffIntakeToken())}`;
  return NextResponse.json({ success: true, url });
}
