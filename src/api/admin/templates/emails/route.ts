import { supabase } from "@/lib/supabaseClient.ts"
import { NextResponse } from "next/server"


export async function GET() {

	const { data, error } = await supabase
		.from("email_templates")
		.select("*")

	if (error) {
		return NextResponse.json(
			{ error: error.message },
			{ status: 500 }
		)
	}

	console.log("email template", data)
	return NextResponse.json(data, {status: 200})

}

