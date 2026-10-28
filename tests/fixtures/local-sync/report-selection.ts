export interface ReportCandidate { id: string; name: string; }
export function selectReport<T extends ReportCandidate>(files: T[], today: string, start: string, end: string, requireFreshFull: boolean) {
  const candidates = files.map(file => ({ file, match: /^Closer_Report_Closing_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})_run_(\d{4}-\d{2}-\d{2})\.csv$/.exec(file.name) }))
    .filter((entry): entry is { file: T; match: RegExpExecArray } => !!entry.match && entry.match[3] <= today)
    .filter(entry => !requireFreshFull || (entry.match[3] === today && entry.match[1] <= start && entry.match[2] >= end))
    .sort((a,b) => b.match[3].localeCompare(a.match[3]));
  if (!candidates.length) throw new Error(requireFreshFull ? "Today's full-coverage detailed extract is not available. Existing data retained." : "No detailed Closer extract is available.");
  const latest = candidates[0];
  const sameDate = candidates.filter(c => c.match[3] === latest.match[3]);
  if (sameDate.length !== 1) throw new Error("Multiple detailed extracts found for the same source date; review required.");
  return latest.file;
}
