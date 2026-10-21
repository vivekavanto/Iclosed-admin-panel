import { auditGoogleJson, auditGoogleToken } from "./google-audit-auth.ts";
import { safeDriveId } from "./google-drive.ts";
export interface AuditDocElement { startIndex?: number; endIndex?: number; paragraph?: { paragraphStyle?: { namedStyleType?: string }; elements?: { textRun?: { content?: string } }[] }; table?: { columns?: number; rows?: number; tableRows?: {tableCells?: {content?: AuditDocElement[]}[]}[] }; }
export interface NativeAuditDoc { documentId: string; revisionId?: string; body?: { content?: AuditDocElement[] }; tabs?: { documentTab?: { body?: {content?: AuditDocElement[]} }; childTabs?: NativeAuditDoc["tabs"] }[]; }
export function inspectAuditDoc(document: NativeAuditDoc) {
  const tables: {columns:number;rows:number}[] = [], headings: string[] = [], texts: string[] = [];
  function elements(items: AuditDocElement[] = []) { for (const item of items) {
    if (item.paragraph) { const text = item.paragraph.elements?.map(e=>e.textRun?.content??"").join("")??""; texts.push(text); if (/^(TITLE|HEADING_[1-6])$/.test(item.paragraph.paragraphStyle?.namedStyleType??"")) headings.push(text.trim()); }
    if (item.table) {tables.push({columns:item.table.columns??0,rows:item.table.rows??0}); for(const row of item.table.tableRows??[])for(const cell of row.tableCells??[])elements(cell.content);}
  }}
  function tabs(items: NativeAuditDoc["tabs"] = []) { for(const tab of items){elements(tab.documentTab?.body?.content);tabs(tab.childTabs);} }
  if(document.tabs?.length) tabs(document.tabs); else elements(document.body?.content);
  return {tables,headings,text:texts.join("")};
}
export class AuditGoogleDocs {
  static async read(documentId: string): Promise<NativeAuditDoc> {
    if(!safeDriveId(documentId))throw new Error("Invalid audit report identity.");
    return auditGoogleJson(`https://docs.googleapis.com/v1/documents/${documentId}?includeTabsContent=true`,await auditGoogleToken("docsRead"));
  }
  static async update(input: { documentId: string; matterFolderId: string; auditFolderId: string; expectedRevision: string; requests: object[] }) {
    if (![input.documentId,input.matterFolderId,input.auditFolderId].every(safeDriveId) || !input.expectedRevision || !input.requests.length || input.requests.length > 500) throw new Error("A verified report destination, current revision and bounded update are required.");
    const token=await auditGoogleToken("docsWrite");
    const metadata=(id:string)=>auditGoogleJson(`https://www.googleapis.com/drive/v3/admin/legal-assistant/files/${id}?fields=id,name,mimeType,parents,trashed,capabilities(canEdit)&supportsAllDrives=true`,token);
    const folder=await metadata(input.auditFolderId),report=await metadata(input.documentId);
    const allowed=(process.env.ORCHESTRATOR_AUDIT_OUTPUT_FOLDER_IDS??"").split(",").map(v=>v.trim()).filter(Boolean);
    if(!allowed.includes(folder.id) || folder.trashed || folder.mimeType!=="application/vnd.google-apps.folder" || !folder.parents?.includes(input.matterFolderId) || report.trashed || report.mimeType!=="application/vnd.google-apps.document" || !report.parents?.includes(folder.id) || !report.capabilities?.canEdit)throw new Error("This report is outside the authorized audit output folder or cannot be edited.");
    const current: NativeAuditDoc = await auditGoogleJson(`https://docs.googleapis.com/v1/documents/${input.documentId}?includeTabsContent=true`,token);
    if(current.revisionId!==input.expectedRevision)throw new Error("The report changed during the audit. Read the current report before retrying.");
    assertClerkFieldsPreserved(current,input.requests);
    // Caller builds scoped edits from a fresh native read; the revision guard prevents overwriting concurrent clerk edits.
    await auditGoogleJson(`https://docs.googleapis.com/v1/documents/${input.documentId}:batchUpdate`,token,{method:"POST",body:JSON.stringify({requests:input.requests,writeControl:{requiredRevisionId:input.expectedRevision}})});
    return AuditGoogleDocs.read(input.documentId);
  }
}

/** Protect clerk-owned tracker text even when the caller holds the current revision. */
export function assertClerkFieldsPreserved(document: NativeAuditDoc, requests: object[]) {
  const ranges: {start:number;end:number}[]=[]; let trackers = 0;
  function visit(items: AuditDocElement[] = []) {for(const item of items){if(!item.table)continue;
    const header=item.table.tableRows?.[0]?.tableCells?.map(cell=>cell.content?.map(e=>e.paragraph?.elements?.map(t=>t.textRun?.content??"").join("")??"").join("")??"")??[];
    if(item.table.columns===7 && /clerk disposition/i.test(header[4]??"") && /clerk notes/i.test(header[5]??"")){trackers++;for(const row of item.table.tableRows?.slice(1)??[])for(const col of [4,5]){
      const content=row.tableCells?.[col]?.content??[];const first=content[0]?.startIndex,last=content[content.length-1]?.endIndex;
      if(first===undefined||last===undefined)throw new Error("Cannot locate protected clerk fields in the current report.");
      ranges.push({start:first,end:last});
    }}
    for(const row of item.table.tableRows??[])for(const cell of row.tableCells??[])visit(cell.content);
  }}
  function tabs(items: NativeAuditDoc["tabs"] = []){for(const tab of items){visit(tab.documentTab?.body?.content);tabs(tab.childTabs);}}
  if(document.tabs?.length)tabs(document.tabs);else visit(document.body?.content);
  if (!trackers) throw new Error("A native seven-column Clerk Action Tracker is required before updating an existing report.");
  // Index shifts from structural edits are difficult to prove safe generically. Only bounded text replacements
  // in one guarded batch are supported for existing reports; composition is handled by the report builder.
  const operations=requests.map(request=>{
    const r=request as {insertText?:{location?:{index?:number};text?:string};deleteContentRange?:{range?:{startIndex?:number;endIndex?:number}}};
    if(Object.keys(request).length!==1 || (!r.insertText && !r.deleteContentRange))throw new Error("Existing-report updates require bounded text edits that preserve clerk fields.");
    const start=r.insertText?.location?.index??r.deleteContentRange?.range?.startIndex;
    const end=r.insertText?start:r.deleteContentRange?.range?.endIndex;
    if(start===undefined || end===undefined || end<start)throw new Error("A bounded report edit is required.");
    return {start,end,insert:!!r.insertText};
  });
  let boundary=Number.POSITIVE_INFINITY;
  for(const op of operations){
    if(op.end>boundary)throw new Error("Existing-report text edits must run from the end toward the beginning without overlapping.");
    if(ranges.some(r=>op.insert?op.start>=r.start&&op.start<=r.end:op.start<r.end&&op.end>r.start))throw new Error("The proposed update touches clerk disposition or notes. Those fields are human-controlled.");
    boundary=op.start;
  }
}
