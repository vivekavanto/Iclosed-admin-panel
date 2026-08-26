import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { rateLimitOk, requestIp } from "@/lib/rateLimit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { readBlobDocument, BlobDocumentError } from "@/lib/blobDocument";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { STATEMENT_OF_ACCOUNT_DOC_TYPE } from "@/lib/depositTask";

// Reads the balance due on closing off the Final Statement of Account.
//
// The figure is at the foot of a statement the firm produced minutes earlier, so
// asking an admin to retype it into the box beside the upload is both busywork
// and the most expensive typo on the file — a purchaser who wires the wrong
// amount doesn't close. This suggests the number; the admin still confirms it.
//
// SUGGESTS, deliberately: the response only fills the input in the drawer. It
// never writes `tasks.balance_due` and never activates anything — saving stays a
// separate PATCH the admin triggers, so no client is ever shown a figure a human
// didn't look at.
//
// Gated to admins by src/middleware.ts.

const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
};

function buildPrompt(): string {
  return `You are reading a Canadian real-estate law firm's FINAL STATEMENT OF ACCOUNT for a property purchase.

Find the ONE figure the purchaser must send to the firm's trust account to close: the BALANCE DUE ON CLOSING.

It is the bottom-line amount owed BY THE CLIENT TO US, and is usually labelled one of:
  - "Balance Due on Closing"
  - "Balance Due From You"
  - "Balance Required to Close"
  - "Total Due"
  - "Amount Due"
  - "Balance Owing"

Rules:
- Return the FINAL total the client owes, not a subtotal, not the purchase price,
  not the mortgage advance, not the deposit already paid, not HST, not the legal
  fee, and not any single disbursement.
- If the statement shows credits (deposit, mortgage advance) subtracted to reach a
  final figure, the figure AFTER those subtractions is the answer.
- If the bottom line is a REFUND to the client (a negative balance, "due to you"),
  set "balance_due": null and explain in "reason" — a refund is not something the
  client deposits, and guessing here would ask them for money they don't owe.
- If you cannot find the figure with confidence, set "balance_due": null. Do NOT
  guess. A wrong number is far worse than no number.

Return ONLY JSON in this exact shape:
{
  "balance_due": 487652.18,
  "label": "Balance Due on Closing",
  "confidence": "high",
  "reason": "short explanation of where the figure came from, or why none was returned"
}

"balance_due" must be a plain number with no currency symbol, commas or spaces, or null.
"confidence" must be one of "high", "medium", "low".`;
}

/** Strip fences/prose Gemini sometimes wraps around its JSON. */
function parseJson(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no JSON object in response");
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

/** The statement on this file, resolved the same way the deposit-task route does. */
async function loadStatement(dealId: string) {
  const familyDealIds = await getFamilyDealIds(dealId);
  const { data: deals } = await supabaseAdmin
    .from("deals")
    .select("lead_id")
    .in("id", familyDealIds)
    .eq("is_deleted", false);

  const leadIds = [
    ...new Set((deals ?? []).map((d) => d.lead_id).filter(Boolean) as string[]),
  ];
  if (leadIds.length === 0) return null;

  const { data } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("id, file_name, file_url")
    .in("lead_id", leadIds)
    .eq("doc_type", STATEMENT_OF_ACCOUNT_DOC_TYPE)
    .order("created_at", { ascending: false })
    .limit(1);

  return data?.[0] ?? null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: "GEMINI_API_KEY is not configured on the server." },
      { status: 500 },
    );
  }

  // Same per-admin ceiling the ID classifier uses (SEC-011), sharing its bucket:
  // both spend against the one Gemini account.
  const actor = await getActingAdmin();
  if (!(await rateLimitOk(`gemini:${actor.id ?? requestIp(req)}`, 30, 3600))) {
    return NextResponse.json(
      { success: false, error: "Too many extraction requests. Please try again later." },
      { status: 429 },
    );
  }

  const statement = await loadStatement(id);
  if (!statement?.file_url) {
    return NextResponse.json(
      { success: false, error: "Upload the Final Statement of Account first" },
      { status: 400 },
    );
  }

  let bytes: Buffer;
  let mimeType: string;
  try {
    const doc = await readBlobDocument(statement.file_url);
    bytes = doc.bytes;
    mimeType =
      doc.meta.contentType && doc.meta.contentType !== "application/octet-stream"
        ? doc.meta.contentType
        : "application/pdf";
  } catch (err) {
    if (err instanceof BlobDocumentError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    logger.error("[DepositTask extract] could not read the statement:", err);
    return NextResponse.json(
      { success: false, error: "Could not read the uploaded statement" },
      { status: 502 },
    );
  }

  if (!SUPPORTED_MIME_TYPES.has(mimeType.toLowerCase())) {
    return NextResponse.json(
      { success: false, error: `Unsupported file type for extraction: ${mimeType}.` },
      { status: 415 },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  let res: Response;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: buildPrompt() },
              { inline_data: { mime_type: mimeType, data: bytes.toString("base64") } },
            ],
          },
        ],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Reading the statement is taking longer than expected. Enter the balance manually."
        : err instanceof Error
          ? err.message
          : "Gemini request failed.";
    return NextResponse.json({ success: false, error: message }, { status: 504 });
  }
  clearTimeout(timeoutId);

  const json = (await res.json().catch(() => ({}))) as GeminiResponse;
  if (!res.ok) {
    return NextResponse.json(
      { success: false, error: json?.error?.message ?? `Gemini request failed (${res.status})` },
      { status: 502 },
    );
  }

  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) {
    return NextResponse.json(
      { success: false, error: "No response from the extractor." },
      { status: 502 },
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJson(text);
  } catch {
    return NextResponse.json(
      { success: false, error: "Could not read the balance from the statement." },
      { status: 502 },
    );
  }

  // A balance is money owed TO us: zero or negative means the model found a
  // refund or misread a credit line, and neither is something to prefill.
  const raw = parsed.balance_due;
  const num = raw === null || raw === undefined ? NaN : Number(String(raw).replace(/[^0-9.\-]/g, ""));
  const balanceDue = Number.isFinite(num) && num > 0 ? num : null;

  return NextResponse.json({
    success: true,
    balance_due: balanceDue,
    label: typeof parsed.label === "string" ? parsed.label : null,
    confidence: typeof parsed.confidence === "string" ? parsed.confidence : "low",
    reason: typeof parsed.reason === "string" ? parsed.reason : null,
    statement: { id: statement.id, file_name: statement.file_name },
  });
}
