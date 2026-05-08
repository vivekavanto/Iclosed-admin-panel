import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const MAX_FILE_NUMBERS = 1000;

export type DealSnapshot = {
  file_number: string;
  type: string | null;
  status: string | null;
  property_address: string | null;
  file_name: string | null;
  clerk_name: string | null;
  lawyer_name: string | null;
  requisition_date: string | null;
  outstanding_undertakings: number | null;
  outstanding_requisitions: number | null;
  closing_date: string | null;
  opening_date: string | null;
};

export async function POST(req: Request) {
  let body: { fileNumbers?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const raw = Array.isArray(body.fileNumbers) ? body.fileNumbers : null;
  if (!raw) {
    return NextResponse.json(
      { success: false, error: "fileNumbers must be an array" },
      { status: 400 },
    );
  }

  const fileNumbers = Array.from(
    new Set(
      raw
        .filter((f): f is string => typeof f === "string")
        .map((f) => f.trim().toUpperCase())
        .filter(Boolean),
    ),
  ).slice(0, MAX_FILE_NUMBERS);

  if (fileNumbers.length === 0) {
    return NextResponse.json({ success: true, existing: {} });
  }

  const { data, error } = await supabaseAdmin
    .from("deals")
    .select(
      "file_number, type, status, property_address, file_name, clerk_name, lawyer_name, requisition_date, outstanding_undertakings, outstanding_requisitions, closing_date, opening_date",
    )
    .in("file_number", fileNumbers);

  if (error) {
    return NextResponse.json(
      { success: false, error: `Lookup failed: ${error.message}` },
      { status: 500 },
    );
  }

  const existing: Record<string, DealSnapshot> = {};
  for (const row of data ?? []) {
    existing[row.file_number] = row as DealSnapshot;
  }

  return NextResponse.json({ success: true, existing });
}
