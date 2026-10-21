"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, FileSearch, FolderOpen, RefreshCw, Search, Upload, X, ChevronRight, AlertCircle, SlidersHorizontal } from "lucide-react";
import Button from "@/components/ui/Button";
import { INITIAL_WINDOW, inDashboard, type Matter, type ImportBatch, clerkForUser, isStale } from "@/lib/orchestrator/model";
import { parseCloserReport, reconcile } from "@/lib/orchestrator/closer-import";

interface Props { auditSummaries?: Record<string,{report:boolean;status:string}>; initialMatters: Matter[]; preview?: boolean; email?: string; manage?: boolean; initialRevision?: number; initialImportDate?: string | null; initialCoverageEnd?: string | null; initialError?: string; }
const label = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : "Not available";
const date = (s: string) => s ? new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(s + "T12:00:00Z")) : "Not provided";

export default function Orchestrator({ auditSummaries = {}, initialMatters, preview = false, email = "", manage = false, initialRevision = 0, initialImportDate = null, initialCoverageEnd = null, initialError }: Props) {
  const [matters, setMatters] = useState(initialMatters);
  const [receiptPending,setReceiptPending]=useState<string|null>(null);
  const [query, setQuery] = useState("");
  const [clerksSelected, setClerksSelected] = useState<string[]>([]);
  const [typesSelected, setTypesSelected] = useState<string[]>([]);
  const [firmsSelected, setFirmsSelected] = useState<string[]>([]);
  const [filterSegment, setFilterSegment] = useState<"clerk" | "type" | "firm">("clerk");
  const [mine, setMine] = useState(false);
  const [auditAction, setAuditAction] = useState<{ matter: Matter; mode: "review" | "rerun" } | null>(null);
  const [selected, setSelected] = useState<Matter | null>(null);
  const [tab, setTab] = useState<"details" | "documents" | "history">("details");
  const [documents, setDocuments] = useState<{id:string;name:string;type:string;url:string}[] | null>(null);
  const [documentError, setDocumentError] = useState("");
  const [notice, setNotice] = useState(initialError ?? "");
  const [revision, setRevision] = useState(initialRevision);
  const [sourceDate, setSourceDate] = useState(initialImportDate);
  const [coverageEnd, setCoverageEnd] = useState(initialCoverageEnd);
  const [folderCursor, setFolderCursor] = useState("");
  const [importing, setImporting] = useState(false);
  const [proposal, setProposal] = useState<{ batch: ImportBatch; csv?: string; counts: ReturnType<typeof reconcile>; checksum?: string; sourceId?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected && !auditAction) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const controls = () => Array.from(modalRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input, select") ?? []);
    controls()[0]?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSelected(null); setAuditAction(null); }
      if (event.key === "Tab") {
        const list = controls(), first = list[0], last = list[list.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", handle);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", handle); previous?.focus(); };
  }, [selected, auditAction]);
  useEffect(() => {
    if (tab !== "documents" || !selected?.driveFolderId || preview) return;
    const controller = new AbortController();
    fetch(`/api/admin/legal-assistant/documents?fileId=${encodeURIComponent(selected.id)}`, {signal:controller.signal})
      .then(async response => {const result=await response.json();if(!response.ok)throw new Error(result.error||"Unable to read file documents.");return result.files;})
      .then(files=>{if(!controller.signal.aborted)setDocuments(files);})
      .catch(error=>{if(!controller.signal.aborted)setDocumentError(error instanceof Error?error.message:"Unable to read file documents.");});
    return ()=>controller.abort();
  },[selected,tab,preview]);
  const assignedClerk = preview ? "Marcela Pitella" : clerkForUser(email);
  const clerks = [...new Set(matters.map(m => m.clerk).filter(Boolean))].sort();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const filtered = useMemo(() => matters.filter(m => inDashboard(m) && (!mine || (!!assignedClerk && m.clerk === assignedClerk)) &&
    (!clerksSelected.length || clerksSelected.includes(m.clerk)) && (!typesSelected.length || typesSelected.includes(m.type)) && (!firmsSelected.length || firmsSelected.includes(m.firm)) &&
    [m.number, m.address, m.clients].some(v => v.toLowerCase().includes(query.toLowerCase()))).sort((a, b) => a.closingDate.localeCompare(b.closingDate) || a.number.localeCompare(b.number)),
  [matters, mine, assignedClerk, clerksSelected, typesSelected, firmsSelected, query]);

  async function inspectFile(file: File) {
    setNotice(""); setProposal(null);
    try {
      if (file.size > 10_000_000) throw new Error("Choose a CSV smaller than 10 MB.");
      const csv = await file.text();
      const batch = parseCloserReport(file.name, csv);
      const counts = reconcile(matters, batch);
      if (preview) { setProposal({ batch, csv, counts }); return; }
      setImporting(true);
      const response = await fetch("/api/admin/legal-assistant/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, csv, action: "preview" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Import preview failed.");
      setRevision(result.revision);
      setProposal({ batch, csv, counts: result.counts, checksum: result.checksum });
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to inspect the report."); }
    finally { setImporting(false); if (fileInput.current) fileInput.current.value = ""; }
  }
  async function applyImport() {
    if (!proposal) return;
    setImporting(true);
    try {
      if (preview) {
        setMatters(proposal.counts.matters); setSourceDate(proposal.batch.sourceDate); setCoverageEnd(proposal.batch.coverageEnd);
        setNotice("Preview updated in this tab only. Nothing was saved to Closer, Drive or the database.");
      } else {
        const response = await fetch(proposal.sourceId ? "/api/admin/legal-assistant/sync" : "/api/admin/legal-assistant/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: proposal.batch.filename, csv: proposal.csv, sourceId:proposal.sourceId, action: "apply", expectedRevision: revision, checksum: proposal.checksum }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Import failed.");
        setMatters(result.matters.map((m:Matter)=>({...m,mortgageInstructions:m.mortgageInstructions??matters.find(prior=>prior.id===m.id)?.mortgageInstructions}))); setRevision(result.revision); setSourceDate(result.sourceDate); setCoverageEnd(result.coverageEnd ?? proposal.batch.coverageEnd);
        setNotice(result.duplicate ? "This extract was already imported; no changes were made." : "Closer extract imported successfully.");
      }
      setProposal(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Import failed; existing data retained."); }
    finally { setImporting(false); }
  }
  async function reviewDriveRefresh() {
    setImporting(true); setNotice("");
    try {
      const response = await fetch("/api/admin/legal-assistant/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"preview"})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Drive refresh failed.");
      setRevision(result.revision); setProposal({batch:result.batch,counts:result.counts,checksum:result.checksum,sourceId:result.sourceId});
    } catch(error) { setNotice(error instanceof Error ? error.message : "Drive refresh failed; previous data retained."); }
    finally {setImporting(false);}
  }
  async function linkDriveFolders() {
    setImporting(true); setNotice("");
    try {
      const response = await fetch("/api/admin/legal-assistant/folders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({afterId:folderCursor})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Folder verification failed.");
      setMatters(result.matters.map((m:Matter)=>({...m,mortgageInstructions:m.mortgageInstructions??matters.find(prior=>prior.id===m.id)?.mortgageInstructions}))); setRevision(result.revision); setFolderCursor(result.nextCursor ?? "");
      setNotice(`${result.linked} folders linked after checking ${result.checked} files. ${result.unresolved.length} need review.${result.nextCursor ? " Click Link Drive folders to check the next group." : " Verification pass finished."}`);
    } catch(error) {setNotice(error instanceof Error ? error.message : "Folder verification failed.");}
    finally {setImporting(false);}
  }
  async function mortgageReceived(m:Matter){if(receiptPending||m.mortgageInstructions)return;setReceiptPending(m.id);try{if(preview){setNotice("Preview only. No receipt was recorded.");return;}const response=await fetch('/api/admin/legal-assistant/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'mortgage',fileId:m.id})});const result=await response.json();if(!response.ok)throw new Error(result.error);setMatters(previous=>previous.map(item=>item.id===m.id?{...item,mortgageInstructions:result.receipt}:item));}catch(e){setNotice(e instanceof Error?e.message:'Receipt could not be recorded.');}finally{setReceiptPending(null);}}
  function openFile(m: Matter) { setSelected(m); setTab("details"); setDocuments(null); setDocumentError(""); }
  return <div className="orch">
    <header className="orch-header"><div className="orch-brand"><span className="orch-title">Legal Assistant</span></div><div className="orch-header-right">{preview ? <span className="orch-preview">Development preview · fictional data</span> : <span>{email}</span>}{!preview&&<a href="/admin/legal-assistant/municipalities">Municipality contacts</a>}{manage && !preview && <a href="/admin/legal-assistant/connections/mailbox">Audit mailbox</a>}</div></header>
    <main className="orch-main">
      {preview && <div className="orch-preview-strip">Interactive development preview. Imports change this tab only. Preview My Files is assigned to Marcela.</div>}
      <div className="orch-topline"><div className="orch-freshness"><RefreshCw size={14}/><span>{sourceDate ? <>Closer extract: <strong>{date(sourceDate)}</strong>{isStale(sourceDate, today) && <span className="orch-amber"> · Refresh needed</span>}</> : "No Closer extract imported"}</span></div><div className="orch-actions">{manage && !preview && <><Button variant="ghost" size="sm" onClick={() => void reviewDriveRefresh()} disabled={importing}><RefreshCw size={15}/>Refresh from Drive</Button><Button variant="ghost" size="sm" onClick={() => void linkDriveFolders()} disabled={importing}><FolderOpen size={15}/>Link Drive folders</Button></>}{(manage || preview) && <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()} disabled={importing}><Upload size={15}/>Import extract</Button>}<Button size="sm" disabled title="File opening will be added after the dashboard pilot">＋ Add file</Button></div></div>
      <input ref={fileInput} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Closer CSV report" onChange={e => { const f = e.target.files?.[0]; if (f) void inspectFile(f); }}/>
      {coverageEnd && coverageEnd < INITIAL_WINDOW.end && <div className="orch-notice" role="status"><AlertCircle size={16}/><span>The connected detailed extract covers closings through {date(coverageEnd)}. December coverage is incomplete; the displayed count is not the full year-end total.</span></div>}
      {notice && <div className="orch-notice" role="status"><AlertCircle size={16}/><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notification"><X size={15}/></button></div>}
      {proposal && <section className="orch-import" aria-label="Import preview"><div><h2>Review Closer import</h2><p>{proposal.batch.filename}</p></div><div className="orch-import-counts"><span><b>{proposal.counts.created}</b> new</span><span><b>{proposal.counts.updated}</b> updated</span><span><b>{proposal.counts.unchanged}</b> unchanged</span><span><b>{proposal.counts.notPresent}</b> not in report</span></div><p>Coverage: {proposal.batch.coverageStart ? date(proposal.batch.coverageStart) : "Active files"} – {date(proposal.batch.coverageEnd)}.</p>{proposal.batch.coverageEnd < INITIAL_WINDOW.end && <p className="orch-amber">This report does not cover all December closings. Files outside its coverage are retained.</p>}{proposal.batch.warnings.map(w => <p key={w}>{w}</p>)}<div className="orch-actions"><Button size="sm" onClick={() => void applyImport()} loading={importing} disabled={!preview && proposal.batch.kind !== "detailed"}>{preview ? "Apply to preview" : "Apply import"}</Button><Button variant="ghost" size="sm" onClick={() => setProposal(null)}>Cancel</Button></div></section>}
      <div className="orch-toolbar"><div className="orch-tabs"><button aria-pressed={!mine} onClick={() => setMine(false)}>All Files</button><button aria-pressed={mine} onClick={() => setMine(true)}>My Files</button></div><div className="orch-filters"><label className="orch-search"><Search size={16}/><input aria-label="Search files" placeholder="Search file, property or client" value={query} onChange={e => setQuery(e.target.value)}/></label><details className="orch-unified-filter"><summary><SlidersHorizontal size={15}/> Filters{(clerksSelected.length + typesSelected.length + firmsSelected.length) > 0 && <span className="orch-filter-count">{clerksSelected.length + typesSelected.length + firmsSelected.length}</span>}</summary><div className="orch-filter-popover"><div className="orch-filter-segments" role="tablist" aria-label="Filter category">{(["clerk", "type", "firm"] as const).map(segment => <button key={segment} role="tab" id={`filter-${segment}`} aria-controls="filter-options" aria-selected={filterSegment === segment} onClick={() => setFilterSegment(segment)}>{segment === "type" ? "Types" : segment === "firm" ? "Firm" : "Clerk"}</button>)}</div><div id="filter-options" role="tabpanel" aria-labelledby={`filter-${filterSegment}`} className="orch-filter-options">{(filterSegment === "clerk" ? clerks.map(c => ({value:c, label:c})) : filterSegment === "type" ? ["purchase", "sale", "refinance"].map(t => ({value:t, label:label(t)})) : [{value:"navawilson", label:"Nava Wilson"},{value:"iclosed",label:"iClosed"}]).map(option => { const values = filterSegment === "clerk" ? clerksSelected : filterSegment === "type" ? typesSelected : firmsSelected; const setter = filterSegment === "clerk" ? setClerksSelected : filterSegment === "type" ? setTypesSelected : setFirmsSelected; return <label key={option.value}><input type="checkbox" checked={values.includes(option.value)} onChange={() => setter(values.includes(option.value) ? values.filter(v => v !== option.value) : [...values, option.value])}/><span>{option.label}</span></label>; })}</div><div className="orch-filter-bottom"><button onClick={() => {setClerksSelected([]);setTypesSelected([]);setFirmsSelected([]);}}>Clear filters</button><button onClick={e => e.currentTarget.closest("details")?.removeAttribute("open")}>Done</button></div></div></details></div></div>
      {mine && !assignedClerk && <p className="orch-empty-hint">Your account has no clerk assignment. All Files remains available.</p>}
      <div className="orch-table-wrap"><table><thead><tr><th>File / property</th><th>Client</th><th>Closing</th><th>Signing audit</th><th>Change of ownership</th><th>Mortgage instructions</th></tr></thead><tbody>{filtered.map(m => <tr key={m.id}><td><button className="orch-file" onClick={() => openFile(m)}>{m.number}<ChevronRight size={13}/></button>{m.driveFolderId ? <a className="orch-address" href={`https://drive.google.com/drive/folders/${m.driveFolderId}`} target="_blank" rel="noopener noreferrer">{m.address}<ArrowUpRight size={13}/></a> : <button className="orch-address" onClick={() => { openFile(m); setNotice(preview ? "This fictional file has no real Drive destination. Verified folder links will open directly from the address." : "A verified Drive folder has not been linked to this file yet."); }}>{m.address}<FolderOpen size={13}/></button>}<span className="orch-secondary">{m.clerk || "Unassigned"}{!m.sourcePresent && " · Not in latest extract"}</span></td><td>{m.clients || <span className="orch-muted">Not in extract</span>}</td><td className="orch-date">{date(m.closingDate)}</td><td>{m.auditReport || auditSummaries[m.id]?.report ? <><div className="orch-audit-actions">{preview ? <a className="orch-review-report" href="/admin/legal-assistant/preview/audit">Review report <ArrowUpRight size={14}/></a> : <a className="orch-review-report" href={m.auditReport?.url ?? `/admin/legal-assistant/files/${encodeURIComponent(m.id)}/audit`} target="_blank" rel="noopener noreferrer">Review report <ArrowUpRight size={14}/></a>}<button className="orch-audit-rerun" aria-label={`Rerun audit for ${m.number}`} title="Rerun signing audit" onClick={()=>setAuditAction({matter:m,mode:"rerun"})}><RefreshCw size={15}/></button></div></> : <><a className="orch-review-report" href={preview ? "/admin/legal-assistant/preview/audit" : `/admin/legal-assistant/files/${encodeURIComponent(m.id)}/audit`}>Begin Audit<ChevronRight size={13}/></a></>}</td><td><a className="orch-review-report" href={preview ? `/admin/legal-assistant/preview/coo?type=${m.type}` : `/admin/legal-assistant/files/${encodeURIComponent(m.id)}/coo`}>{m.type === "refinance" ? "Check transfer scope" : "Prepare COO"}<ChevronRight size={13}/></a></td><td>{m.mortgageInstructions?<span title={`Recorded by ${m.mortgageInstructions.email}`}><strong>Received</strong><br/>{new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(m.mortgageInstructions.at))}</span>:<Button size="sm" variant="secondary" disabled={receiptPending!==null} onClick={()=>void mortgageReceived(m)}>Mortgage instructions received</Button>}</td></tr>)}</tbody></table>{filtered.length === 0 && <div className="orch-empty"><FileSearch size={27}/><h2>No matching files</h2><p>{matters.length ? "Try another search or filter." : "Import a Closer extract to get started."}</p></div>}</div>
      <footer className="orch-footer"><span aria-live="polite">{filtered.length} {filtered.length === 1 ? "file" : "files"}{mine ? " assigned to you" : " in this view"}</span><span>File details maintained in Closer{preview ? " · Sample workflow states" : ""}</span></footer>
      {auditAction && <div className="orch-modal-backdrop" onClick={e => {if(e.target===e.currentTarget)setAuditAction(null);}}><section ref={modalRef} className="orch-modal orch-audit-dialog" role="dialog" aria-modal="true" aria-labelledby="audit-action-title"><div className="orch-modal-heading"><div><span className="orch-eyebrow">{auditAction.matter.number}</span><h2 id="audit-action-title">{auditAction.mode === "review" ? "Sample audit report" : "Rerun signing audit?"}</h2></div><button className="orch-icon-button" aria-label="Close audit dialog" onClick={()=>setAuditAction(null)}><X size={20}/></button></div>{auditAction.mode === "review" ? <p>This fictional report demonstrates the review action. Real reports open as Google Docs in the file’s Drive folder.</p> : <><p>A rerun will review the selected package again. The existing report, clerk notes and review history will be preserved.</p><p className="orch-detail-note">{preview ? "Preview only. No documents will be processed and no audit will be submitted." : "Confirm to choose the current signing package. A new run is submitted only after you confirm that package in the audit workspace."}</p></>}<div className="orch-actions"><Button variant="ghost" size="sm" onClick={()=>setAuditAction(null)}>Cancel</Button>{auditAction.mode === "rerun" && <Button size="sm" onClick={()=>{if(preview){setAuditAction(null);setNotice("Preview only: no audit was submitted.");}else{window.location.assign(`/admin/legal-assistant/files/${encodeURIComponent(auditAction.matter.id)}/audit?rerun=1`);}}}>Confirm rerun</Button>}</div></section></div>}
      {selected && <div className="orch-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}><section ref={modalRef} className="orch-modal" role="dialog" aria-modal="true" aria-labelledby="matter-heading"><div className="orch-modal-heading"><div><span className="orch-eyebrow">{selected.number} · {label(selected.type)}</span><h2 id="matter-heading">{selected.address}</h2><p>{selected.firm === "iclosed" ? "iClosed" : "Nava Wilson"}</p></div><button className="orch-icon-button" aria-label="Close file details" onClick={() => setSelected(null)}><X size={20}/></button></div><div className="orch-detail-tabs"><button aria-pressed={tab === "details"} onClick={() => setTab("details")}>File details</button><button aria-pressed={tab === "documents"} onClick={() => {setDocuments(null);setDocumentError("");setTab("documents");}}>Documents</button><button aria-pressed={tab === "history"} onClick={() => setTab("history")}>Source & history</button></div>{tab === "details" ? <><dl className="orch-details">{[["Clients", selected.clients], ["Closing date", date(selected.closingDate)], ["Clerk", selected.clerk], ["Lawyer", selected.lawyer], ["Client email", selected.clientEmail], ["Client phone", selected.clientPhone], ["Opening date", date(selected.openingDate)], ["Closer status", label(selected.status)], ["Property type", selected.propertyType], ["Purchase price", selected.propertyPrice], ["Condominium", selected.condominium===undefined?"Not specified":selected.condominium?"Yes":"No"], ["Condo corporation", selected.condoCorporation || (selected.condominium?"Not supplied by Closer":"")], ["Other law firm", selected.opposingCounsel?.firm], ["Other lawyer", selected.opposingCounsel?.lawyer], ["Other lawyer email", selected.opposingCounsel?.email]].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || "Not provided"}</dd></div>)}</dl><div className="orch-detail-links">{selected.closerUrl ? <a href={selected.closerUrl} target="_blank" rel="noopener noreferrer">Open in Closer <ArrowUpRight size={15}/></a> : <span>Closer link unavailable in this {preview ? "fictional record" : "extract"}.</span>}{selected.driveFolderId ? <a href={`https://drive.google.com/drive/folders/${selected.driveFolderId}`} target="_blank" rel="noopener noreferrer">Open Drive folder <ArrowUpRight size={15}/></a> : <span>Drive folder not yet linked.</span>}</div><p className="orch-detail-note">Edit file details in Closer. Changes appear here after the next successful extract import.</p></> : tab === "documents" ? <div className="orch-history">{!selected.driveFolderId ? <p>Link a verified Drive folder to browse this file’s documents.</p> : documentError ? <p role="alert">{documentError}</p> : documents === null ? <p role="status">Reading the linked Drive folder…</p> : documents.length === 0 ? <p>No items in the linked folder.</p> : <ul className="orch-documents">{documents.map(file=><li key={file.id}><a href={file.url} target="_blank" rel="noopener noreferrer">{file.type === "application/vnd.google-apps.folder" ? <FolderOpen size={16}/> : <FileSearch size={16}/>}<span>{file.name}</span><ArrowUpRight size={13}/></a></li>)}</ul>}</div> : <div className="orch-history"><h3>Latest source</h3><p>Closer extract dated {date(selected.sourceDate)}</p><p>{selected.sourcePresent ? "Present in the imported source." : "Not present in the latest report covering this closing date. Previous details retained; closure is not inferred."}</p><p>Stable reference: {selected.id}</p><p>Audit reports, COO packets and workflow history will be added with their respective components.</p></div>}</section></div>}
    </main>
  </div>;
}
