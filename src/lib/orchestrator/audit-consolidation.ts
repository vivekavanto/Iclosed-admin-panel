import type {AuditManifest,AuditCandidate} from './audit-model.ts';
/** A synthesis view only. Frozen sources and publication-time quote validation stay unchanged. */
export function auditConsolidationEvidence(manifest:AuditManifest,findings:AuditCandidate[]){
 if(JSON.stringify(manifest).length<=600_000)return {manifest,compacted:false};
 const view:AuditManifest={...manifest,limitations:[...manifest.limitations,'Final synthesis uses bounded page excerpts and full-source-pass observations. Full captured sources remain available; do not claim a fresh full-text review in synthesis.'],sources:manifest.sources.map(source=>({...source,pages:source.pages.map(page=>{
  const text=page.text.replace(/\s+/g,' ').trim(),ranges:[number,number][]=[[0,Math.min(400,text.length)],[Math.max(0,text.length-200),text.length]];
  for(const e of findings.flatMap(f=>f.evidence).filter(e=>e.sourceId===source.id&&e.page===page.number)){
   const quote=e.quote.replace(/\s+/g,' ').trim(),start=text.indexOf(quote);if(start>=0)ranges.push([Math.max(0,start-180),Math.min(text.length,start+quote.length+180)]);
  }
  ranges.sort((a,b)=>a[0]-b[0]);const merged:[number,number][]=[];for(const range of ranges){const last=merged.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else merged.push([...range]);}
  return {...page,text:merged.map(([start,end])=>text.slice(start,end)).filter(Boolean).join('\n[Excerpt boundary]\n')};
 })}))};
 return {manifest:view,compacted:true};
}
