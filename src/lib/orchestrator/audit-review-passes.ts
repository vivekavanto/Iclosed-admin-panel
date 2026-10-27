import type {AuditManifest} from './audit-model.ts';
/** Reuse the exact package in each bounded source pass; consolidation sees all frozen text. */
export function auditReviewPasses(manifest:AuditManifest){
 const primary=manifest.sources.find(s=>s.kind==='package');if(!primary)throw new Error('No frozen primary package.');
 if(manifest.sources.reduce((n,s)=>n+s.pages.length,0)<=160&&JSON.stringify(manifest).length<=600_000)return [manifest];
 const passes:AuditManifest[]=[];let group:AuditManifest['sources']=[primary],pages=primary.pages.length;
 for(const source of manifest.sources.filter(s=>s!==primary)){
  if(group.length>1&&(group.length>=9||pages+source.pages.length>160)){passes.push({...manifest,sources:group});group=[primary];pages=primary.pages.length;}
  group.push(source);pages+=source.pages.length;
 }
 if(group.length>1||!passes.length)passes.push({...manifest,sources:group});
 return passes;
}
