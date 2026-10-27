import type { Matter } from './model.ts';

export const PAST_FILES_START = '2026-10-23';
export const CLOSING_VIEWS = [
  {id:'five-days',label:'Next week'},
  {id:'month',label:'Next month'},
  {id:'past',label:'Past files'},
] as const;
export type ClosingView = typeof CLOSING_VIEWS[number]['id'];
export function torontoDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
function dateParts(day:string) {
  const date = new Date(day+'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(date.getTime()) || date.toISOString().slice(0,10)!==day) throw new Error('A valid closing-view date is required.');
  return date;
}
export function addCalendarDays(day:string,days:number) {
  const date=dateParts(day);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);
}
/** Rolling calendar month, with Jan 31 clamped to the last day of February. */
export function nextMonthEnd(today:string) {
  const date=dateParts(today),day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+1);
  const lastDay=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  date.setUTCDate(Math.min(day,lastDay));return date.toISOString().slice(0,10);
}
export function closingWindow(view:ClosingView,today:string) {
  return view==='past'?{start:PAST_FILES_START,end:addCalendarDays(today,-1)}:{start:today,end:view==='five-days'?addCalendarDays(today,6):nextMonthEnd(today)};
}
export function inClosingView(matter: Pick<Matter,'closingDate'|'status'>,view:ClosingView,today:string) {
  const {start,end}=closingWindow(view,today);
  if (matter.closingDate<start || matter.closingDate>end) return false;
  // Past is a date view, not an assertion that an active file has completed.
  // Keep its actual Closer status and retain files absent from later extracts.
  // A file closed today must remain reachable for post-closing COO work.
  return (view==='past'?['active','closed','inactive']:['active','closed']).includes(matter.status);
}
