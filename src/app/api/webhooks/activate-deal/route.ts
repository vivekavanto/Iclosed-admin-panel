import { NextRequest, NextResponse } from "next/server";
import { activateClientDeals } from "@/lib/activateClientDeals";

/**
 * POST /api/webhooks/activate-deal
 *
 * Called by the customer portal after account activation / set-password
 * (or first login). Flips Inactive → Active without relying on a DB trigger.
 *
 * Body: { email: string } | { lead_id: string } | { client_id: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, lead_id, client_id } = body as {
      email?: string;
      lead_id?: string;
      client_id?: string;
    };

    if (!email && !lead_id && !client_id) {
      return NextResponse.json(
        { success: false, error: "email, lead_id, or client_id required" },
        { status: 400 },
      );
    }

    const result = await activateClientDeals({
      email: email ?? null,
      leadId: lead_id ?? null,
      clientId: client_id ?? null,
    });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      activated: result.activated,
      message:
        result.activated > 0
          ? `Activated ${result.activated} deal(s)`
          : "No Inactive deals to activate (already Active or not found)",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    console.error("POST /api/webhooks/activate-deal error:", err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
