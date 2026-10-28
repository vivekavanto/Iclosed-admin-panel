import {hostedConfiguration,hostedDocumentsEnabled,requireHostedBaseline} from "./hosted/document.ts";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { reconcile } from "./closer-import.ts";
import type { Matter, ImportBatch } from "./model.ts";
import { localStateDirectory, localSnapshot, applyLocalBatch, saveVerifiedLocalFolder } from "./local-store.ts";

function db() {
  if (typeof window !== "undefined") throw new Error("Workflow store is server-only.");
  const hosted=hostedConfiguration();
  const url = hosted?.url??process.env.NEXT_PUBLIC_SUPABASE_URL, key = hosted?.key??process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Workflow database is not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
export function reportChecksum(filename: string, csv: string) {
  return createHash("sha256").update(filename).update("\0").update(csv).digest("hex");
}
export async function getSnapshot(): Promise<{ matters: Matter[]; revision: number; sourceDate: string | null; coverageStart?: string | null; coverageEnd?: string | null }> {
  if(hostedDocumentsEnabled())await requireHostedBaseline();
  if (hostedDocumentsEnabled()||localStateDirectory()) return localSnapshot();
  const { data, error } = await db().rpc("orchestrator_snapshot");
  if (error || !data) throw new Error("Unable to read workflow register.");
  return data;
}
export async function applyBatch(batch: ImportBatch, checksum: string, expectedRevision: number, actor: string) {
  if (batch.kind !== "detailed") throw new Error("Detailed Closer export required to apply an import.");
  if (hostedDocumentsEnabled()||localStateDirectory()) return applyLocalBatch(batch, checksum, expectedRevision, actor);
  const snapshot = await getSnapshot();
  const { data: prior, error: priorError } = await db().from("orchestrator_imports").select("checksum").eq("checksum", checksum).maybeSingle();
  if (priorError) throw new Error("Unable to verify import history; existing data retained.");
  if (prior) return { ...await getSnapshot(), duplicate: true };
  if (snapshot.revision !== expectedRevision) throw new Error("Data changed since the preview. Review the import again.");
  const counts = reconcile(snapshot.matters, batch);
  const { data, error } = await db().rpc("orchestrator_apply_import", {
    p_checksum: checksum, p_expected_revision: expectedRevision, p_source_date: batch.sourceDate,
    p_filename: batch.filename, p_actor: actor, p_coverage_start: batch.coverageStart, p_coverage_end: batch.coverageEnd,
    p_matters: counts.matters,
  });
  if (error) throw new Error(error.message.includes("STALE_REVISION") ? "Data changed since the preview. Review the import again." : error.message.includes("OLDER_EXTRACT") ? "A newer extract has already been imported." : "Import could not be committed; existing data retained.");
  return { ...await getSnapshot(), duplicate: data.duplicate };
}

export async function linkVerifiedFolder(input: { id: string; folderId: string; name: string; rootId: string; actor: string; expectedRevision: number }) {
  if (hostedDocumentsEnabled()||localStateDirectory()) return saveVerifiedLocalFolder(input);
  const { error } = await db().rpc("orchestrator_link_folder", {
    p_file_id:input.id,p_folder_id:input.folderId,p_name:input.name,p_root_id:input.rootId,p_actor:input.actor,p_expected_revision:input.expectedRevision,
  });
  if (error) throw new Error(error.message.includes("STALE_REVISION") ? "The register changed. Refresh before linking a folder." : "The verified folder could not be saved.");
  return getSnapshot();
}
