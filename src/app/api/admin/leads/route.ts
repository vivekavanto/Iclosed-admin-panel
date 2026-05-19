import { NextRequest, NextResponse } from 'next/server';
import supabaseAdmin from '@/lib/supabaseAdmin';

// camelCase payload key → DB column (whitelist; anything not listed is dropped)
const LEAD_FIELD_MAP: Record<string, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
  isCorporate: 'is_corporate',
  corporateName: 'corporate_name',
  incNumber: 'inc_number',
  addressStreet: 'address_street',
  addressUnit: 'address_unit',
  addressCity: 'address_city',
  addressPostalCode: 'address_postal_code',
  addressProvince: 'address_province',
  propertyType: 'property_type',
  ownershipHistory: 'ownership_history',
  maritalStatus: 'marital_status',
  citizenshipStatus: 'citizenship_status',
  occupation: 'occupation',
  employerPhone: 'employer_phone',
  status: 'status',
  leadType: 'lead_type',
  price: 'price',
  service: 'service',
  subService: 'sub_service',
  apsSigned: 'aps_signed',
  referralSource: 'referral_source',
  sellingAddressStreet: 'selling_address_street',
  sellingAddressCity: 'selling_address_city',
  sellingAddressPostalCode: 'selling_address_postal_code',
  sellingAddressProvince: 'selling_address_province',
};

// GET /api/admin/leads
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, leads: data ?? [] });
}

// PUT /api/admin/leads — update a lead's editable fields
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, ...rest } = body ?? {};

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'id is required' },
        { status: 400 },
      );
    }

    const updateData: Record<string, any> = {};
    for (const [key, column] of Object.entries(LEAD_FIELD_MAP)) {
      if (rest[key] !== undefined) {
        const value = rest[key];
        updateData[column] = typeof value === 'string' && value.trim() === '' ? null : value;
      }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No editable fields provided' },
        { status: 400 },
      );
    }

    const { data, error } = await supabaseAdmin
      .from('leads')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('PUT /api/admin/leads error:', error);
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, lead: data });
  } catch (err: any) {
    console.error('PUT /api/admin/leads exception:', err);
    return NextResponse.json(
      { success: false, error: err.message ?? 'Unknown error' },
      { status: 500 },
    );
  }
}

// DELETE /api/admin/leads?id=...
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
