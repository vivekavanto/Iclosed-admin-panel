import {hostedDocumentsEnabled,readHostedDocument,changeHostedDocument} from "./hosted/document.ts";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditReportLink, ImportBatch, Matter } from "./model.ts";
import { reconcile } from "./closer-import.ts";

export interface LocalState {
  revision: number;
  sourceDate: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  matters: Matter[];
  imports: { checksum: string; filename: string; actor: string; at: string }[];
  changes: { id: string; revision: number; at: string; before: Matter | null; after: Matter }[];
  folderChecks: { id: string; folderId: string; name: string; checkedAt: string; rootId: string; actor: string }[];
}
export function localStateDirectory() {
  const value = process.env.ORCHESTRATOR_LOCAL_STATE_DIR;
  if (!value) return null;
  if (process.env.NODE_ENV === "production") throw new Error("Local development storage is unavailable in production.");
  const directory = path.resolve(value);
  // Never permit application-private client data under a publicly served tree.
  if (directory === path.resolve("public") || directory.startsWith(path.resolve("public") + path.sep)) throw new Error("Unsafe local state directory.");
  return directory;
}
async function load(): Promise<LocalState> {
  if(hostedDocumentsEnabled())return readHostedDocument<LocalState>("register",()=>{throw Error("The verified hosted register baseline is missing. Existing local data was retained.");});
  const directory = localStateDirectory();
  if (!directory) throw new Error("Local development storage is not configured.");
  try { return JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Local register could not be read; existing data retained.");
    return { revision: 0, sourceDate: null, coverageStart: null, coverageEnd: null, matters: [], imports: [], changes: [], folderChecks: [] };
  }
}
export async function localSnapshot() {
  const s = await load();
  return { matters: s.matters, revision: s.revision, sourceDate: s.sourceDate, coverageStart: s.coverageStart, coverageEnd: s.coverageEnd };
}
async function mutate<T>(operation: (s: LocalState) => T) {
  if(hostedDocumentsEnabled())return changeHostedDocument<LocalState,T>("register",()=>{throw Error("The verified hosted register baseline is missing.");},operation);
  const directory = localStateDirectory();
  if (!directory) throw new Error("Local development storage is not configured.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".write-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error("Another register operation is in progress. Refresh and retry."); }
  const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
  try {
    const state = await load();
    const result = operation(state);
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, path.join(directory, "state.json"));
    return result;
  } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }); }
}
export async function applyLocalBatch(batch: ImportBatch, checksum: string, revision: number, actor: string) {
  const committed = await mutate(s => {
    if (s.imports.some(i => i.checksum === checksum)) return {duplicate:true,revision:s.revision,matters:s.matters};
    if (s.revision !== revision) throw new Error("Data changed since the preview. Review the import again.");
    if (batch.kind !== "detailed") throw new Error("Detailed Closer export required.");
    if(s.sourceDate&&batch.sourceDate<s.sourceDate)throw Error("A newer extract has already been imported.");
    const next = reconcile(s.matters, batch), at = new Date().toISOString();
    for (const m of next.matters) {
      const before = s.matters.find(p => p.id === m.id) ?? null;
      if (JSON.stringify(before) !== JSON.stringify(m)) s.changes.push({ id: m.id, revision: s.revision + 1, at, before, after: m });
    }
    s.matters = next.matters; s.revision++; s.sourceDate = batch.sourceDate;
    s.coverageStart = batch.coverageStart; s.coverageEnd = batch.coverageEnd;
    s.imports.push({ checksum, filename: batch.filename, actor, at });
    return {duplicate:false,revision:s.revision,matters:s.matters};
  });
  const saved=await load();if(!saved.imports.some(i=>i.checksum===checksum)||(!committed.duplicate&&(saved.revision!==committed.revision||JSON.stringify(saved.matters)!==JSON.stringify(committed.matters))))throw Error("Saved register rows or import receipt could not be verified. Reload before retrying.");
  return { matters:saved.matters,revision:saved.revision,sourceDate:saved.sourceDate,coverageStart:saved.coverageStart,coverageEnd:saved.coverageEnd, duplicate:committed.duplicate };
}
export async function saveVerifiedLocalFolder(input: { id: string; folderId: string; name: string; rootId: string; actor: string; expectedRevision: number }) {
  await mutate(s => {
    if (s.revision !== input.expectedRevision) throw new Error("The file register changed. Refresh before linking a folder.");
    const matter = s.matters.find(m => m.id === input.id);
    if (!matter) throw new Error("File not found.");
    const before = { ...matter }, at = new Date().toISOString();
    matter.driveFolderId = input.folderId; s.revision++;
    s.folderChecks.push({ id: input.id, folderId: input.folderId, name: input.name, rootId: input.rootId, actor: input.actor, checkedAt: at });
    s.changes.push({ id: matter.id, revision: s.revision, at, before, after: { ...matter } });
  });
  return localSnapshot();
}

export async function saveVerifiedLocalAuditReport(input: { id: string; matterFolderId: string; report: AuditReportLink; expectedRevision: number }) {
  if (!/^[A-Za-z0-9_-]+$/.test(input.report.documentId) || input.report.url !== `https://docs.google.com/document/d/${input.report.documentId}/edit` || !Number.isFinite(Date.parse(input.report.verifiedAt))) throw new Error("Invalid verified audit report link.");
  await mutate(s => {
    if(s.revision!==input.expectedRevision)throw new Error("The register changed before the report link was saved.");
    const matter=s.matters.find(m=>m.id===input.id);
    if(!matter?.driveFolderId || matter.driveFolderId!==input.matterFolderId)throw new Error("The audit report must belong to the linked matter folder.");
    const before={...matter},at=new Date().toISOString();matter.auditReport=input.report;s.revision++;
    s.changes.push({id:matter.id,revision:s.revision,at,before,after:{...matter}});
  });
  return localSnapshot();
}

/** Enrich only source lender metadata from the already-approved detailed extract. */
export async function enrichLocalLenders(batch:ImportBatch,expectedRevision:number){
  if(batch.kind!=='detailed')throw new Error('Detailed extract required.');
  let updated=0;
  await mutate(s=>{
    if(s.revision!==expectedRevision||(!s.sourceDate||batch.sourceDate>s.sourceDate)||!s.imports.some(i=>i.filename===batch.filename))throw new Error('The approved extract or register revision changed.');
    const nextRevision=s.revision+1,at=new Date().toISOString();
    for(const incoming of batch.matters){
      const matter=s.matters.find(m=>m.id===incoming.id&&m.number===incoming.number);
      if(!matter||(batch.sourceDate<s.sourceDate!&&matter.lenders!==undefined)||JSON.stringify(matter.lenders)===JSON.stringify(incoming.lenders))continue;
      const before={...matter};matter.lenders=incoming.lenders;
      s.changes.push({id:matter.id,revision:nextRevision,at,before,after:{...matter}});updated++;
    }
    if(updated)s.revision=nextRevision;
  });
  return {...await localSnapshot(),updated};
}

/** Backfill contact metadata only from an extract already accepted into this register. */
export async function enrichLocalContacts(batch:ImportBatch,expectedRevision:number){
 if(batch.kind!=='detailed')throw Error('Detailed extract required.');let updated=0;
 await mutate(s=>{
  if(s.revision!==expectedRevision||!s.sourceDate||batch.sourceDate>s.sourceDate||!s.imports.some(i=>i.filename===batch.filename))throw Error('Approved extract or register revision changed.');
  const at=new Date().toISOString();
  for(const incoming of batch.matters){const matter=s.matters.find(m=>m.id===incoming.id&&m.number===incoming.number);if(!matter||(batch.sourceDate<s.sourceDate&&matter.clientEmails!==undefined))continue;
   if(JSON.stringify([matter.clientEmails,matter.referralAgentEmails])===JSON.stringify([incoming.clientEmails,incoming.referralAgentEmails]))continue;
   const before={...matter};matter.clientEmails=incoming.clientEmails;matter.referralAgentEmails=incoming.referralAgentEmails;
   s.changes.push({id:matter.id,revision:s.revision+1,at,before,after:{...matter}});updated++;
  }if(updated)s.revision++;
 });return {...await localSnapshot(),updated};
}
