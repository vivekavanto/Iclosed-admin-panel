import type {DriveItem} from './google-drive.ts';

// Keep previous audit outputs out of evidence and prioritize operative source documents.
export function auditSourcePriority(name:string) {
  name=name.replace(/[_-]+/g,' ');
  if (/signing.*(?:audit|review|qa)|audit.*report|clerk.*tracker/i.test(name)) return -1;
  if (/parcel|title.?search|\bpin\b|amendment|waiver|agreement.*purchase|\baps\b|lender|mortgage.*instruction|commitment|payout|discharge.*statement/i.test(name)) return 0;
  if (/parcel|\bpin\b|title|transfer|charge|statement.*adjustment|ledger|commission|tax|requisition/i.test(name)) return 1;
  return 2;
}
export function orderedAuditSources(items:DriveItem[]) {
  return items.filter(x=>auditSourcePriority(x.name)>=0).sort((a,b)=>auditSourcePriority(a.name)-auditSourcePriority(b.name)||a.name.localeCompare(b.name,'en')||a.id.localeCompare(b.id));
}
export function privateAuditAttachment(name:string){
 const normalized=name.replace(/[_-]+/g,' ');
 return /\bids?\b|passport|driv(?:ing|er'?s?)\s+licen[cs]e|void\s*(?:cheque|check)|(?:client|lawyer)\s+void/i.test(normalized);
}
