import { propertyLabel } from './dashboard-display.ts';

export interface PackagePdf { id:string; name:string; }
const aliases:Record<string,string>={street:'st',road:'rd',avenue:'ave',boulevard:'blvd',crescent:'cres',cr:'cres',court:'ct',crt:'ct',drive:'dr',place:'pl',lane:'ln',terrace:'terr',trail:'trl',tr:'trl',square:'sq',highway:'hwy',parkway:'pkwy'};
const normalize=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(t=>aliases[t]??t).join(' ');
export function defaultPackagePdf(sources:PackagePdf[],address:string):PackagePdf|null {
  const pdfs=sources.filter(s=>/\.pdf$/i.test(s.name)&&!/(?:\breports?\b|\breviews?\b|\bqa\b|\baudit\b|\binstructions?\b|\bchecklist\b)/i.test(s.name));
  const named=pdfs.filter(s=>/\bsigning[\s_-]*package\b/i.test(s.name));
  if(named.length)return named.length===1?named[0]:null;
  const street=address.split(',')[0].trim(),city=address.split(',')[1]?.trim();
  const streetTokens=normalize(street).split(' ');
  if(!streetTokens.some(t=>/^\d/.test(t))||!streetTokens.some(t=>/^[a-z]/.test(t)))return null;
  const suffixes=new Set(Object.values(aliases));
  const shortStreet=suffixes.has(streetTokens.at(-1)??'')?streetTokens.slice(0,-1).join(' '):streetTokens.join(' ');
  const alternatives=new Set([normalize(address),normalize(propertyLabel(address)),normalize(street),shortStreet,...(city?[normalize(street+' '+city),normalize(shortStreet+' '+city)]:[])]);
  const matches=pdfs.filter(s=>alternatives.has(normalize(s.name.replace(/\.pdf$/i,''))));
  if(matches.length)return matches.length===1?matches[0]:null;
  // Address-only spelling tolerance: one substitution in one long street token.
  // Building/unit numbers, road type, token order and every other token stay exact.
  const near=(candidate:string,expected:string)=>{
    const a=candidate.split(' '),b=expected.split(' ');if(a.length!==b.length)return false;
    let differences=0;
    for(let i=0;i<a.length;i++){
      if(a[i]===b[i])continue;
      if(!/^[a-z]{5,}$/.test(a[i])||!/^[a-z]{5,}$/.test(b[i])||suffixes.has(a[i])||suffixes.has(b[i])||a[i].length!==b[i].length)return false;
      if([...a[i]].filter((letter,j)=>letter!==b[i][j]).length!==1)return false;
      differences++;
    }
    return differences===1;
  };
  const spellingMatches=pdfs.filter(source=>[...alternatives].some(expected=>near(normalize(source.name.replace(/\.pdf$/i,'')),expected)));
  return spellingMatches.length===1?spellingMatches[0]:null;
}
