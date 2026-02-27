import { NextResponse } from "next/server"
import { testSupabaseConnection } from "@/lib/supabaseClient"

export async function GET() {
  const result = await testSupabaseConnection()
  return NextResponse.json(result)
}