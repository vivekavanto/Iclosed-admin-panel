import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

// GET /api/admin/leads
export async function GET() {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, leads: data });
}
