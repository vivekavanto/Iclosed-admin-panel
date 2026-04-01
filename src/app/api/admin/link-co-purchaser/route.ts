import { NextResponse } from "next/server";

const getPortalUrl = () =>
  (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://iclosed-customer-application-rosy.vercel.app").replace(/\/+$/, "");

/**
 * POST /api/admin/link-co-purchaser
 * Proxies to the customer portal to approve a co-purchaser link.
 * Body: { lead_id: string }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { lead_id } = body;

    if (!lead_id) {
      return NextResponse.json({ success: false, error: "lead_id is required" }, { status: 400 });
    }

    const res = await fetch(`${getPortalUrl()}/api/admin/link-co-purchaser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id }),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message ?? "Proxy error" }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/link-co-purchaser
 * Proxies to the customer portal to dismiss a co-purchaser flag.
 * Body: { lead_id: string }
 */
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { lead_id } = body;

    if (!lead_id) {
      return NextResponse.json({ success: false, error: "lead_id is required" }, { status: 400 });
    }

    const res = await fetch(`${getPortalUrl()}/api/admin/link-co-purchaser`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id }),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message ?? "Proxy error" }, { status: 500 });
  }
}
