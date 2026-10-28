import type {AuditManifest} from './audit-model.ts';
export function auditCoverageSummary(manifest:AuditManifest|undefined){
 if(!manifest)return undefined;
 const pdfPages=manifest.sources.filter(s=>s.kind!=='email').flatMap(s=>s.pages);
 return {pdfPages:pdfPages.length,renderedPdfPages:pdfPages.filter(p=>p.rendered).length,unrenderedPages:manifest.sources.filter(s=>s.kind!=='email').reduce((n,s)=>n+s.pages.filter(p=>!p.rendered).length,0),packagePages:manifest.sources.filter(s=>s.kind==='package').reduce((n,s)=>n+s.pages.length,0),supportDocuments:manifest.sources.filter(s=>s.kind==='support').length,emailMessages:manifest.sources.filter(s=>s.kind==='email').length,ocrPages:manifest.sources.reduce((n,s)=>n+s.pages.filter(p=>p.textMethod==='ocr').length,0),unreadablePages:manifest.sources.reduce((n,s)=>n+s.pages.filter(p=>p.textNeedsReview||p.text.trim().length<30||p.text.includes('(cid:')).length,0),sources:manifest.sources.map(s=>({id:s.id,name:s.name,kind:s.kind,pages:s.pages.length}))};
}
