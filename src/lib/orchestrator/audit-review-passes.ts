import type {AuditManifest} from './audit-model.ts';
/** Every PDF gets a bounded native visual pass; consolidation sees all frozen text. */
export function auditReviewPasses(manifest:AuditManifest){
 const primary=manifest.sources.find(s=>s.kind==='package');if(!primary)throw new Error('No frozen primary package.');
 const bytes=(s:AuditManifest['sources'][number])=>s.byteLength??0;
 if(manifest.sources.reduce((n,s)=>n+s.pages.length,0)<=160&&manifest.sources.reduce((n,s)=>n+bytes(s),0)<=30_000_000&&JSON.stringify(manifest).length<=600_000)return [manifest];
 const passes:AuditManifest[]=[];let group=[primary],pages=primary.pages.length,size=bytes(primary),textSize=JSON.stringify(primary).length;
 for(const source of manifest.sources.filter(s=>s!==primary)){
  if((source.kind!=="email"&&group.filter(s=>s.kind!=="email").length>=9)||pages+source.pages.length>160||size+bytes(source)>30_000_000||textSize+JSON.stringify(source).length>500_000){
   if(group.length>1||!passes.length)passes.push({...manifest,sources:group});group=[primary];pages=0;size=0;textSize=JSON.stringify(primary).length;
  }
  group.push(source);pages+=source.pages.length;size+=bytes(source);textSize+=JSON.stringify(source).length;
 }
 if(group.length>1||!passes.length)passes.push({...manifest,sources:group});
 return passes;
}
