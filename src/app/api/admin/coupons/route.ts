import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabase = supabaseAdmin;

// A coupon is a standalone shared discount. Brokers point at it via
// brokers.coupon_id (one coupon → many brokers), so the join here is the
// reverse: which brokers currently reference this coupon.

// GET /api/admin/coupons
export async function GET() {
  const { data, error } = await supabase
    .from("coupons")
    .select("*, brokers(id, name)")
    .eq("is_deleted", false)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

// POST /api/admin/coupons
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { code, discount_type, discount_value, is_active } = body;

  if (!code) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("coupons")
    .insert([
      {
        code,
        discount_type: discount_type || null,
        discount_value: discount_value ?? null,
        is_active: is_active ?? true,
      },
    ])
    .select("*, brokers(id, name)")
    .single();

  if (error) {
    // 23505 = unique_violation (the case-insensitive code index).
    if (error.code === "23505") {
      return NextResponse.json(
        { error: `A coupon with code "${code}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

// PUT /api/admin/coupons
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, code, discount_type, discount_value, is_active } = body;

  if (!id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (code !== undefined) updateData.code = code;
  if (discount_type !== undefined) updateData.discount_type = discount_type || null;
  if (discount_value !== undefined) updateData.discount_value = discount_value ?? null;
  if (is_active !== undefined) updateData.is_active = is_active;

  const { data, error } = await supabase
    .from("coupons")
    .update(updateData)
    .eq("id", id)
    .select("*, brokers(id, name)")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: `A coupon with code "${code}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// DELETE /api/admin/coupons?id=...
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  let id = searchParams.get("id");

  if (!id) {
    try {
      const body = await req.json();
      id = body?.id ?? null;
    } catch {
      // no body — fall through
    }
  }

  if (!id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  // Soft-delete the coupon, then unlink any brokers still pointing at it so the
  // brokers list doesn't keep showing a deleted coupon on the join.
  const { data, error } = await supabase
    .from("coupons")
    .update({ is_deleted: true, is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Coupon not found" }, { status: 404 });
  }

  let unlinkedBrokers = 0;
  try {
    const { data: brokers } = await supabase
      .from("brokers")
      .update({ coupon_id: null })
      .eq("coupon_id", id)
      .select("id");
    unlinkedBrokers = brokers?.length ?? 0;
  } catch (unlinkErr) {
    console.error("[Coupon DELETE] Unlink brokers failed (non-blocking):", unlinkErr);
  }

  return NextResponse.json({ success: true, id, unlinkedBrokers });
}
