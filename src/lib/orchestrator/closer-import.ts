import type { ImportBatch, Matter, FileType } from "./model.ts";

// RFC 4180: quoted commas, escaped quotes, CRLF and embedded newlines.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, "");
  if (text.length > 10_000_000) throw new Error("Report exceeds the 10 MB import limit.");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else if (quoted) { quoted = false; closed = true; }
      else if (!value && !closed) quoted = true;
      else throw new Error("Invalid quote in CSV report.");
    } else if (!quoted && (c === "," || c === "\n" || c === "\r")) {
      row.push(value); value = ""; closed = false;
      if (c !== ",") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (row.some(v => v.trim())) rows.push(row);
        row = [];
      }
    } else {
      if (closed) throw new Error("Unexpected content after a quoted CSV field.");
      value += c;
    }
  }
  if (quoted) throw new Error("Report ends inside a quoted field; download may be incomplete.");
  if (value || row.length || closed) { row.push(value); if (row.some(v => v.trim())) rows.push(row); }
  return rows;
}

export function dateValue(value: string, optional = false): string {
  if (!value && optional) return "";
  let iso = value;
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const long = /^(\w+) (\d{1,2}), (\d{4})$/.exec(value);
  if (long) {
    const month = monthNames.findIndex(m => m.toLowerCase() === long[1].toLowerCase());
    if (month >= 0) iso = `${long[3]}-${String(month + 1).padStart(2, "0")}-${long[2].padStart(2, "0")}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== iso) {
    throw new Error(`Invalid date: ${value || "missing"}.`);
  }
  return iso;
}

export function closerIdentity(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== "https://app.closer.ca" || u.username || u.password) return null;
    const match = /^\/app\/matter\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
    return match ? match[1] : null;
  } catch { return null; }
}

export function parseCloserReport(filename: string, text: string): ImportBatch {
  const detailed = /^Closer_Report_Closing_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})_run_(\d{4}-\d{2}-\d{2})\.csv$/.exec(filename);
  const summary = /^Closer_Active_Files_Closing_by_(\d{4}-\d{2}-\d{2})_run_(\d{4}-\d{2}-\d{2})\.csv$/.exec(filename);
  if (!detailed && !summary) throw new Error("Choose a named Closer detailed or active-files CSV export.");
  const sourceDate = dateValue(detailed?.[3] ?? summary![2]);
  const coverageStart = detailed ? dateValue(detailed[1]) : null;
  const coverageEnd = dateValue(detailed?.[2] ?? summary![1]);
  if (coverageStart && coverageStart > coverageEnd) throw new Error("Invalid report coverage.");
  const rows = parseCsv(text), headers = rows.shift();
  if (!headers || rows.length === 0) throw new Error("Empty report; the existing data has been retained.");
  if (new Set(headers).size !== headers.length) throw new Error("Duplicate CSV column names.");
  const required = detailed
    ? ["file.number", "file.type", "file.status", "file.url", "dates.closing", "property.address", "file.clerk", "file.lawyer", "clients.names"]
    : ["File Number", "File Type", "Status", "Closing date", "Address", "Clerk", "Lawyer"];
  for (const h of required) if (!headers.includes(h)) throw new Error(`Required column missing: ${h}.`);
  const ids = new Set<string>(), numbers = new Set<string>();
  const warnings: string[] = [];
  const matters = rows.map((row, index): Matter => {
    if (row.length !== headers.length) throw new Error(`Row ${index + 2} has ${row.length} fields; expected ${headers.length}.`);
    const obj = Object.fromEntries(headers.map((h, i) => [h, row[i].trim()]));
    const field = (a: string, b: string) => obj[detailed ? a : b] ?? "";
    const number = field("file.number", "File Number").toUpperCase();
    const type = field("file.type", "File Type").toLowerCase();
    const status = field("file.status", "Status").toLowerCase();
    if (!number || !/^(?:\d{2}[A-Z]{1,3}-\d{3,5})$/.test(number)) throw new Error(`Row ${index + 2}: invalid file number.`);
    if (!["purchase", "sale", "refinance"].includes(type)) throw new Error(`Row ${index + 2}: unsupported transaction type.`);
    if (!["active", "closed", "inactive"].includes(status)) throw new Error(`Row ${index + 2}: unrecognized file status.`);
    const closerId = detailed ? closerIdentity(obj["file.url"]) : null;
    if (detailed && !closerId) throw new Error(`Row ${index + 2}: invalid Closer file URL.`);
    const id = closerId ? `closer:${closerId}` : `number:${number}`;
    if (ids.has(id) || numbers.has(number)) throw new Error(`Duplicate file identity at row ${index + 2}; reconcile the source report.`);
    ids.add(id); numbers.add(number);
    const closingDate = dateValue(field("dates.closing", "Closing date"));
    if ((coverageStart && closingDate < coverageStart) || closingDate > coverageEnd) throw new Error(`Row ${index + 2}: closing date is outside the named report coverage.`);
    const address = field("property.address", "Address");
    if (!address) throw new Error(`Row ${index + 2}: property address is missing.`);
    if (!field("file.clerk", "Clerk")) warnings.push(`${number}: clerk assignment is missing.`);
    return {
      id, number, name: field("file.name", "File Name"), type: type as FileType,
      firm: "navawilson", address, clients: obj["clients.names"] || obj["clients.list.0.name"] || "",
      clientEmail: obj["clients.list.0.email"] || "", clientPhone: obj["clients.list.0.phoneNumber"] || "",
      clerk: field("file.clerk", "Clerk"), lawyer: field("file.lawyer", "Lawyer"), closingDate,
      openingDate: dateValue(field("dates.opening", "Opening date"), true), status,
      closerUrl: closerId ? `https://app.closer.ca/app/matter/${closerId}` : null,
      driveFolderId: null, sourceDate, sourcePresent: true,
      ...(detailed?{
        propertyType:obj["property.type"]||"",propertyPrice:obj["property.price"]||"",condoType:obj["property.condoType"]||"",condoPlan:obj["property.condoPlan"]||"",
        ...(["condo","home"].includes(obj["property.type"])?{condominium:obj["property.type"]==="condo"}:{}),
        condoCorporation:obj["property.condoCorporation.name"]||obj["condominium.corporation.name"]||"",condoEmail:obj["property.condoCorporation.email"]||obj["condominium.corporation.email"]||"",
        opposingCounsel:{firm:obj["lawFirm.name"]||"",lawyer:obj["lawFirm.lawyer.name"]||"",email:obj["lawFirm.lawyer.email"]||"",clerk:obj["lawFirm.clerk.name"]||"",clerkEmail:obj["lawFirm.clerk.email"]||"",phone:obj["lawFirm.lawyer.phone"]||""},
      }:{}),
    };
  });
  if (!detailed) warnings.push("Summary export: client details and stable Closer links are unavailable. Preview only; use a detailed export to apply an import.");
  return { filename, sourceDate, coverageStart, coverageEnd, kind: detailed ? "detailed" : "summary", matters, warnings };
}

export function reconcile(existing: Matter[], batch: ImportBatch) {
  if (existing.some(m => m.sourceDate > batch.sourceDate)) throw new Error("A newer extract has already been imported.");
  const result = existing.map(m => ({ ...m }));
  let created = 0, updated = 0, unchanged = 0;
  for (const incoming of batch.matters) {
    const sameId = result.findIndex(m => m.id === incoming.id);
    const sameNumber = result.findIndex(m => m.number === incoming.number);
    if (sameId >= 0 && sameNumber >= 0 && sameId !== sameNumber) throw new Error("Conflicting file number and Closer identities; review required.");
    if (sameId < 0 && sameNumber >= 0 && result[sameNumber].closerUrl && incoming.closerUrl && result[sameNumber].closerUrl !== incoming.closerUrl) throw new Error("A file number maps to different Closer matters; review required.");
    const index = sameId >= 0 ? sameId : sameNumber;
    if (index < 0) { result.push(incoming); created++; }
    else {
      const prior = result[index];
      const merged = { ...incoming, firm: prior.firm, driveFolderId: prior.driveFolderId, ...(prior.auditReport ? { auditReport: prior.auditReport } : {}) };
      if (JSON.stringify({ ...prior, sourceDate: incoming.sourceDate, sourcePresent: true }) === JSON.stringify(merged)) unchanged++; else updated++;
      result[index] = merged;
    }
  }
  const incomingIds = new Set(batch.matters.map(m => m.id));
  for (const m of result) {
    if (!incomingIds.has(m.id) && (!batch.coverageStart || m.closingDate >= batch.coverageStart) && m.closingDate <= batch.coverageEnd) m.sourcePresent = false;
  }
  return { matters: result, created, updated, unchanged, notPresent: result.filter(m => !m.sourcePresent).length };
}
