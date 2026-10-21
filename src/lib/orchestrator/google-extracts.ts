import { ReadOnlyDrive } from "./google-drive.ts";
import { selectReport } from "./report-selection.ts";
import { parseCloserReport } from "./closer-import.ts";
import { INITIAL_WINDOW } from "./model.ts";

export const CLOSER_REPORT_FOLDER = "1Hr-AtW5WePs-cPEndoc2E7PGAtGI-ipL";
export async function getDetailedExtract(today: string, requireFreshFull = true) {
  const drive = await ReadOnlyDrive.connect();
  const folder = process.env.ORCHESTRATOR_CLOSER_FOLDER_ID || CLOSER_REPORT_FOLDER;
  const files = await drive.children(folder);
  const file = selectReport(files, today, INITIAL_WINDOW.start, INITIAL_WINDOW.end, requireFreshFull);
  const csv = await drive.csv(file);
  return { csv, batch: parseCloserReport(file.name, csv), sourceId: file.id };
}
export const latestDetailedExtract = (today: string) => getDetailedExtract(today, true);
