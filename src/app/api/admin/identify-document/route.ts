import { NextResponse } from "next/server";
import { rateLimitOk, requestIp } from "@/lib/rateLimit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { readBlobDocument, BlobDocumentError } from "@/lib/blobDocument";

const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const ACCEPTABLE_IDS = [
  "Canadian Passport",
  "Driver's License",
  "Canadian Citizenship Card",
  "Permanent Resident Card",
  "NEXUS Card",
  "SIN Card (plastic only)",
  "Foreign Passport",
  "Government-issued Photo ID Card",
];

const REJECTED_ID_KEYWORDS = [
  "health card", "ohip", "ramq", "msp", "bc services card", "medical card",
  "insurance card", "library card", "student", "school id", "employee",
  "work id", "membership", "loyalty", "credit card", "debit card", "bank card",
  "transit", "metro", "presto", "social insurance number slip", "sin paper",
  "birth certificate", "marriage certificate",
];

const ACCEPTABLE_IDS_NORMALIZED = new Set(ACCEPTABLE_IDS.map((s) => s.toLowerCase()));

function isAcceptableIdType(documentType: string): boolean {
  const normalized = documentType.trim().toLowerCase();
  if (!normalized) return false;
  for (const bad of REJECTED_ID_KEYWORDS) {
    if (normalized.includes(bad)) return false;
  }
  return ACCEPTABLE_IDS_NORMALIZED.has(normalized);
}

const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp",
  "image/heic", "image/heif", "application/pdf",
]);

function buildPrompt() {
  return `You are a STRICT document classifier helping verify a Canadian real-estate client's identification under Law Society of Ontario By-Law 7.1.

Your job is to decide whether the uploaded image/PDF contains ACCEPTABLE government-issued identification. Be conservative — when in doubt, REJECT.

============================================================
ACCEPTABLE document types (these are the ONLY valid types):
${ACCEPTABLE_IDS.map((d) => `   - ${d}`).join("\n")}
============================================================

============================================================
EXPLICITLY REJECTED documents — these must NEVER be classified as identification, even if they look official, are government-issued, or contain a photo. If the upload is one of these (or only contains these), set "contains_identification": false and return an empty "documents" array:
   - Health Cards of any kind (Ontario OHIP / red-and-white or photo, Quebec RAMQ, BC Services Card, Alberta AHCIP, any provincial/territorial health insurance card, any private medical/insurance card)
   - Birth certificates, marriage certificates, death certificates
   - Paper SIN slips or SIN confirmation letters (only the plastic SIN card is acceptable, and even then it must clearly be the plastic card)
   - Library cards, student IDs, school IDs, employee/work IDs, gym/membership cards, loyalty cards
   - Credit cards, debit cards, bank cards
   - Transit cards (Presto, OPUS, Compass, etc.)
   - Vehicle ownership / vehicle registration / vehicle insurance pink slips
   - Utility bills, bank statements, tax documents, letters
   - Screenshots of websites, selfies, random photos of people, contracts, blank pages
   - Expired IDs that are clearly past their expiry date
============================================================

For EACH distinct identification document you find in the image/PDF, do the following:

1. Verify it is a real, physical, government-issued identification document that matches EXACTLY one of the ACCEPTABLE types above.
2. Use the EXACT label from the ACCEPTABLE list as "document_type".
3. Determine which side(s) are visible: "front", "back", "front-and-back", or "unknown".
4. Decide required side rule: "single-sided", "front-and-back", or "unknown".
5. Extract the EXPIRY DATE in YYYY-MM-DD format, or null if not visible.

Edge-case policy:
- EVERY acceptable ID is "front-and-back" required — never return "single-sided".
- Passports need BOTH sides: the photo/bio-data page is the "front", the SIGNATURE page is the "back". A passport is only "is_complete": true when both are visible.
- ⚠️ A passport is very often photographed OPEN, as a two-page spread. If ONE image shows the signature page AND the photo/bio-data page side by side, that is BOTH sides — return "side": "front-and-back" and "is_complete": true. Do NOT return "front" just because the bio-data page is the more prominent half. This is the single most common passport mistake: look at the WHOLE image, both halves, before deciding.
- How to recognise the signature page: it carries the words "Signature of bearer" / "Signature du titulaire" (or the equivalent in the issuing country's language), usually above a handwritten signature and a line of small print about the passport being invalid unless signed. A visible handwritten signature on the page facing the bio-data page means the signature page IS present.
- Only return "front" for a passport when the signature page is genuinely absent from the image — i.e. you can see the bio-data page alone, with no facing page or with a facing page that is blank/unrelated.
- A passport back is sometimes a plain cover or a near-blank page — still classify it as the passport's "back", not as an unidentifiable document.
- Cards (Driver's License, PR Card, etc.) are "front-and-back" required.
- Driver's license backs (with PDF417 barcode, magstripe) are VALID identification.
- Users may scan multiple distinct IDs onto one file — return one entry per ID.
- Health cards must always be rejected with contains_identification=false.

Respond with ONLY a valid JSON object (no markdown):

{
  "contains_identification": boolean,
  "documents": [
    {
      "document_type": string,
      "side": "front" | "back" | "front-and-back" | "unknown",
      "side_requirement": "single-sided" | "front-and-back" | "unknown",
      "is_complete": boolean,
      "confidence": "high" | "medium" | "low",
      "expiry_date": string | null
    }
  ],
  "summary": {
    "total_documents": number,
    "complete_documents": number,
    "document_types_found": string[]
  },
  "reason": string
}`;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

type Side = "front" | "back" | "front-and-back" | "unknown";
type SideRequirement = "single-sided" | "front-and-back" | "unknown";
type Confidence = "high" | "medium" | "low";
type ExpiryStatus = "valid" | "expired" | "expiring_soon" | "unknown";

interface DocumentEntry {
  document_type: string;
  side: Side;
  side_requirement: SideRequirement;
  is_complete: boolean;
  confidence: Confidence;
  expiry_date: string | null;
  expiry_status: ExpiryStatus;
}

interface MultiDocumentResult {
  contains_identification: boolean;
  documents: DocumentEntry[];
  summary: { total_documents: number; complete_documents: number; document_types_found: string[] };
  reason: string;
}

interface IdentificationResult {
  is_identification: boolean;
  document_type: string | null;
  side: Side;
  side_requirement: SideRequirement;
  confidence: Confidence;
  reason: string;
  expiry_date: string | null;
  expiry_status: ExpiryStatus;
  multiple_documents?: DocumentEntry[];
  summary?: { total_documents: number; complete_documents: number; document_types_found: string[] };
}

function parseSide(side: unknown): Side {
  if (side === "front" || side === "back" || side === "front-and-back") return side;
  return "unknown";
}
function parseSideRequirement(req: unknown): SideRequirement {
  if (req === "single-sided" || req === "front-and-back") return req;
  return "unknown";
}
function parseConfidence(conf: unknown): Confidence {
  if (conf === "high" || conf === "medium" || conf === "low") return conf;
  return "low";
}

function parseExpiryDate(rawDate: unknown): { date: string | null; status: ExpiryStatus } {
  if (typeof rawDate !== "string" || !rawDate.trim()) return { date: null, status: "unknown" };
  const dateStr = rawDate.trim();
  let parsedDate: Date | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    parsedDate = new Date(dateStr + "T00:00:00");
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
    const parts = dateStr.split("/");
    parsedDate = new Date(`${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}T00:00:00`);
  } else {
    parsedDate = new Date(dateStr);
  }
  if (!parsedDate || isNaN(parsedDate.getTime())) return { date: dateStr, status: "unknown" };
  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const normalizedDate = parsedDate.toISOString().split("T")[0];
  if (parsedDate < now) return { date: normalizedDate, status: "expired" };
  if (parsedDate <= thirtyDaysFromNow) return { date: normalizedDate, status: "expiring_soon" };
  return { date: normalizedDate, status: "valid" };
}

function parseGeminiJson(text: string): IdentificationResult {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(cleaned) as Partial<MultiDocumentResult>;

  if (typeof parsed.contains_identification === "boolean" && Array.isArray(parsed.documents)) {
    const rawDocuments: DocumentEntry[] = parsed.documents
      .filter((d) => typeof d?.document_type === "string" && d.document_type.trim().length > 0)
      .map((d) => {
        const expiry = parseExpiryDate(d.expiry_date);
        return {
          document_type: d.document_type.trim(),
          side: parseSide(d.side),
          side_requirement: parseSideRequirement(d.side_requirement),
          is_complete: Boolean(d.is_complete),
          confidence: parseConfidence(d.confidence),
          expiry_date: expiry.date,
          expiry_status: expiry.status,
        };
      });

    const documents = rawDocuments.filter((d) => isAcceptableIdType(d.document_type));
    const rejectedDocuments = rawDocuments.filter((d) => !isAcceptableIdType(d.document_type));

    let reason = typeof parsed.reason === "string" ? parsed.reason : "";
    if (rejectedDocuments.length > 0 && documents.length === 0) {
      const rejectedTypes = [...new Set(rejectedDocuments.map((d) => d.document_type))].join(", ");
      reason = reason
        ? `${reason} (Rejected: ${rejectedTypes} is not an acceptable ID under LSO By-Law 7.1.)`
        : `${rejectedTypes} is not an acceptable government-issued ID under LSO By-Law 7.1.`;
    }

    const summary = {
      total_documents: documents.length,
      complete_documents: documents.filter((d) => d.is_complete).length,
      document_types_found: [...new Set(documents.map((d) => d.document_type))],
    };
    const primary = documents[0];
    return {
      is_identification: parsed.contains_identification && documents.length > 0,
      document_type: primary?.document_type ?? null,
      side: primary?.side ?? "unknown",
      side_requirement: primary?.side_requirement ?? "unknown",
      confidence: primary?.confidence ?? "low",
      reason,
      expiry_date: primary?.expiry_date ?? null,
      expiry_status: primary?.expiry_status ?? "unknown",
      multiple_documents: documents.length > 0 ? documents : undefined,
      summary: documents.length > 0 ? summary : undefined,
    };
  }

  return {
    is_identification: false,
    document_type: null,
    side: "unknown",
    side_requirement: "unknown",
    confidence: "low",
    reason: "Unexpected response from classifier.",
    expiry_date: null,
    expiry_status: "unknown",
  };
}

/**
 * Get the bytes to classify, from either request shape:
 *
 *   1. JSON  { file_url, file_name?, mime_type? }  ← preferred
 *      The browser uploaded the document straight to Vercel Blob, so only the
 *      URL is posted here (a few hundred bytes) and the bytes are read back
 *      server-side. This is what allows documents above Vercel's ~4.5 MB
 *      request-body cap to be identified at all — a 4.5–10 MB PDF used to be
 *      rejected by the platform before this handler ever ran, which surfaced in
 *      the drawer as a bare "Unable to process".
 *
 *   2. multipart/form-data with a `file`  ← legacy, unchanged
 *
 * Everything after this point — the prompt, the model, inline_data, the parser,
 * the acceptable-ID whitelist, side/expiry/confidence handling — is identical
 * for both modes. Only the byte SOURCE differs.
 */
async function loadDocument(
  req: Request,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const contentType = (req.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/json")) {
    const body = (await req.json()) as Record<string, unknown>;
    const fileUrl = typeof body.file_url === "string" ? body.file_url : "";
    if (!fileUrl) {
      throw new BlobDocumentError("No file_url provided.", 400);
    }

    const { bytes, meta } = await readBlobDocument(fileUrl);
    // Prefer the stored blob's own content type; fall back to what the client
    // reported, then to the generic type so the SUPPORTED_MIME_TYPES check can
    // reject it with a clear message.
    const mimeType =
      meta.contentType && meta.contentType !== "application/octet-stream"
        ? meta.contentType
        : typeof body.mime_type === "string" && body.mime_type
          ? body.mime_type
          : "application/octet-stream";

    return { bytes, mimeType };
  }

  const formData = await req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    throw new BlobDocumentError("No file provided.", 400);
  }

  const arrayBuffer = await file.arrayBuffer();
  return {
    bytes: Buffer.from(arrayBuffer),
    mimeType: file.type || "application/octet-stream",
  };
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ success: false, error: "GEMINI_API_KEY is not configured on the server." }, { status: 500 });
    }

    // SEC-011: rate-limit Gemini classification per admin (30/hr) so a
    // compromised admin session can't drive unbounded Gemini API spend.
    const actor = await getActingAdmin();
    const rlKey = `gemini:${actor.id ?? requestIp(req)}`;
    if (!(await rateLimitOk(rlKey, 30, 3600))) {
      return NextResponse.json(
        { success: false, error: "Too many identification requests. Please try again later." },
        { status: 429 },
      );
    }

    // Two input modes — see loadDocument(). The JSON/blob-URL mode is what the
    // drawer uses now; the multipart mode is kept for any existing caller.
    let doc: { bytes: Buffer; mimeType: string };
    try {
      doc = await loadDocument(req);
    } catch (err: unknown) {
      if (err instanceof BlobDocumentError) {
        return NextResponse.json(
          { success: false, error: err.message },
          { status: err.status },
        );
      }
      throw err;
    }

    const mimeType = doc.mimeType;
    if (!SUPPORTED_MIME_TYPES.has(mimeType.toLowerCase())) {
      return NextResponse.json(
        { success: false, error: `Unsupported file type for identification: ${mimeType}.` },
        { status: 415 },
      );
    }

    const base64Data = doc.bytes.toString("base64");

    const body = {
      contents: [{
        role: "user",
        parts: [
          { text: buildPrompt() },
          { inline_data: { mime_type: mimeType, data: base64Data } },
        ],
      }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45_000);

    let res: Response;
    try {
      res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "Document verification is taking longer than expected. Please try again."
          : err instanceof Error ? err.message : "Gemini request failed.";
      return NextResponse.json({ success: false, error: message }, { status: 504 });
    }
    clearTimeout(timeoutId);

    const json = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) {
      const message = json?.error?.message ?? `Gemini request failed (${res.status})`;
      return NextResponse.json({ success: false, error: message }, { status: 502 });
    }

    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) {
      return NextResponse.json({ success: false, error: "No response text from Gemini." }, { status: 502 });
    }

    let result: IdentificationResult;
    try {
      result = parseGeminiJson(text);
    } catch {
      return NextResponse.json({ success: false, error: "Could not parse Gemini response.", raw: text }, { status: 502 });
    }

    return NextResponse.json({ success: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
