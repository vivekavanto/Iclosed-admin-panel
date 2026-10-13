import { google } from "googleapis";
import { parseTicklerRows, type TicklerRow } from "./ticklerMatch";

export async function readTicklerRows(): Promise<TicklerRow[]> {
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = (process.env.GOOGLE_SA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const sheetId = process.env.TICKLER_SHEET_ID;
  const tab = process.env.TICKLER_SHEET_TAB || "Sheet1";
  if (!email || !key || !sheetId) {
    throw new Error("GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY / TICKLER_SHEET_ID are not configured.");
  }

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const res = await google.sheets({ version: "v4", auth }).spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tab}!A:H`,
  });
  return parseTicklerRows((res.data.values ?? []) as string[][]);
}
