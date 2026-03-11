import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  const { data, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email")


  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  console.log(data, "clients data");
  return NextResponse.json(data);
}