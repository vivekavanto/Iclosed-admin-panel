import type { Matter } from './model.ts';
import { inClosingView, type ClosingView } from './closing-views.ts';

/** Display only: retain the full source address for matching and notices. */
export function propertyLabel(address: string) {
  return address.replace(/(?:,\s*)(?:ON|Ontario|QC|Quebec|BC|British Columbia|AB|Alberta|MB|Manitoba|NB|New Brunswick|NL|Newfoundland and Labrador|NS|Nova Scotia|NT|Northwest Territories|NU|Nunavut|PE|Prince Edward Island|SK|Saskatchewan|YT|Yukon)\b.*$/i, '').replace(/,?\s*[A-Z]\d[A-Z][ -]?\d[A-Z]\d\s*$/i, '').trim();
}
export function closingLabel(day: string) {
  return day ? new Intl.DateTimeFormat('en-CA', { month:'short', day:'numeric', timeZone:'UTC' }).format(new Date(day+'T12:00:00Z')) : 'Not provided';
}
export interface DashboardFilters { view:ClosingView; today:string; mine:boolean; assignedClerk:string|null; clerks:string[]; types:string[]; firms:string[]; query:string; }
export function dashboardMatters(matters:Matter[], filters:DashboardFilters) {
  const f=filters, query=f.query.trim().toLowerCase(), fileQuery=query.replace(/[^a-z0-9]/g,'');
  return matters.filter(m=>!m.lenders?.some(lender=>/\bantrim\b/i.test(lender)) && inClosingView(m,f.view,f.today)
    && (!f.mine || (!!f.assignedClerk && m.clerk===f.assignedClerk))
    && (!f.clerks.length || f.clerks.includes(m.clerk))
    && (!f.types.length || f.types.includes(m.type))
    && (!f.firms.length || f.firms.includes(m.firm))
    && ([m.number,m.address,m.clients].some(v=>v.toLowerCase().includes(query)) || (!!fileQuery && m.number.toLowerCase().replace(/[^a-z0-9]/g,'').includes(fileQuery))))
    .sort((a,b)=>(f.view==='past'?b.closingDate.localeCompare(a.closingDate):a.closingDate.localeCompare(b.closingDate))||a.number.localeCompare(b.number));
}
