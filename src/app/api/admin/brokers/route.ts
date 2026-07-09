import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabase = supabaseAdmin;

// A broker is a referral source mapped to at most one shared coupon
// (brokers.coupon_id → coupons.id). GET joins the coupon so the list can show
// the linked code + discount.

// GET /api/admin/brokers
export async function GET() {
  const { data, error } = await supabase
    .from("brokers")
    .select("*, coupons(id, code, discount_type, discount_value)")
    .eq("is_deleted", false)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

// POST /api/admin/brokers
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, email, phone, type, company, coupon_id } = body;

  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("brokers")
    .insert([
      {
        name,
        email: email || null,
        phone: phone || null,
        type: type || null,
        company: company || null,
        coupon_id: coupon_id || null,
      },
    ])
    .select("*, coupons(id, code, discount_type, discount_value)")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

// PUT /api/admin/brokers
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, name, email, phone, type, company, coupon_id } = body;

  if (!id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined) updateData.name = name;
  if (email !== undefined) updateData.email = email || null;
  if (phone !== undefined) updateData.phone = phone || null;
  if (type !== undefined) updateData.type = type || null;
  if (company !== undefined) updateData.company = company || null;
  if (coupon_id !== undefined) updateData.coupon_id = coupon_id || null;

  const { data, error } = await supabase
    .from("brokers")
    .update(updateData)
    .eq("id", id)
    .select("*, coupons(id, code, discount_type, discount_value)")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// DELETE /api/admin/brokers?id=...
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

  const { data, error } = await supabase
    .from("brokers")
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Broker not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, id });
}
