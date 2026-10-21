import { ReadOnlyDrive, type DriveItem } from "./google-drive.ts";
import { folderMatchesMatter, MATTER_ROOT } from "./folder-matching.ts";
import type { Matter } from "./model.ts";

export interface FolderMatch { matterId: string; folderId: string; name: string; rootId: string; }
export async function discoverMatterFolders(matters: Matter[]) {
  const drive = await ReadOnlyDrive.connect();
  const roots = (process.env.ORCHESTRATOR_MATTER_ROOT_IDS || MATTER_ROOT).split(",").map(s => s.trim()).filter(Boolean);
  await Promise.all(roots.map(id => drive.metadata(id)));
  const cache = new Map<string, DriveItem>();
  async function withinRoot(folder: DriveItem) {
    let frontier = folder.parents ?? [], depth = 0;
    const visited = new Set<string>();
    while (frontier.length && depth++ < 25) {
      const next: string[] = [];
      for (const id of frontier) {
        if (roots.includes(id)) return id;
        if (visited.has(id)) continue;
        visited.add(id);
        let item = cache.get(id);
        if (!item) { item = await drive.metadata(id); cache.set(id, item); }
        next.push(...item.parents ?? []);
      }
      frontier = next;
    }
    return null;
  }
  const matches: FolderMatch[] = [], unresolved: { matterId: string; reason: string }[] = [];
  for (const matter of matters) {
    if (matter.driveFolderId) continue;
    // File numbers are validated on import; escape defensively for provider queries.
    const safe = matter.number.replace(/\\/g,"\\\\").replace(/'/g,"\\'");
    const candidates = await drive.list(`mimeType='application/vnd.google-apps.folder' and trashed=false and name contains '${safe}'`);
    const verified: FolderMatch[] = [];
    for (const candidate of candidates) {
      if (!folderMatchesMatter(matter, candidate.name)) continue;
      const rootId = await withinRoot(candidate);
      if (rootId) verified.push({ matterId: matter.id, folderId: candidate.id, name: candidate.name, rootId });
    }
    if (verified.length === 1) matches.push(verified[0]);
    else unresolved.push({ matterId: matter.id, reason: verified.length ? "Multiple matching matter folders; human review required." : "No unique folder with matching file number, property and approved ancestry was found." });
  }
  return { matches, unresolved };
}
