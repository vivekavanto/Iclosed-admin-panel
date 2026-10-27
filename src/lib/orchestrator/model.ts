export type FirmKey = "navawilson" | "iclosed";
export type FileType = "purchase" | "sale" | "refinance";
export interface AuditReportLink { documentId: string; url: string; verifiedAt: string; }
export interface Matter {
  id: string;
  number: string;
  name: string;
  type: FileType;
  firm: FirmKey;
  address: string;
  clients: string;
  clientEmail: string;
  clientEmails?: string[];
  referralAgentEmails?: string[];
  clientPhone: string;
  lenders?: string[];
  clerk: string;
  lawyer: string;
  closingDate: string;
  openingDate: string;
  status: string;
  closerUrl: string | null;
  driveFolderId: string | null;
  sourceDate: string;
  sourcePresent: boolean;
  mortgageClientsInformed?: {at:string;actor:string;email:string};
  mortgageInstructions?: {at:string;actor:string;email:string};
  auditReport?: AuditReportLink;
  propertyType?: string;
  propertyPrice?: string;
  condoType?: string;
  condoPlan?: string;
  condominium?: boolean;
  condoCorporation?: string;
  condoEmail?: string;
  opposingCounsel?: {firm:string;lawyer:string;email:string;clerk:string;clerkEmail:string;phone:string};
}
export interface ImportBatch {
  filename: string;
  sourceDate: string;
  coverageStart: string | null;
  coverageEnd: string;
  kind: "detailed" | "summary";
  matters: Matter[];
  warnings: string[];
}
export const INITIAL_WINDOW = { start: "2026-10-21", end: "2026-12-31" };
export function inDashboard(m: Matter, start = INITIAL_WINDOW.start, end = INITIAL_WINDOW.end) {
  return m.status === "active" && m.closingDate >= start && m.closingDate <= end;
}
export function isStale(sourceDate: string | null, today: string) {
  return !sourceDate || sourceDate < today;
}
export function clerkForUser(email: string | null | undefined) {
  const names: Record<string, string> = {
    "marcela@navawilson.law": "Marcela Pitella",
    "suganya@navawilson.law": "Suganya Argeen",
    "abishan@navawilson.law": "Abishan Thuraiaiya",
    "jahanvi@navawilson.law": "Jahanvi Rana",
  };
  return names[email?.toLowerCase() ?? ""] ?? null;
}
export function emailForClerk(name:string){
  const roster:Record<string,string>={"marcela pitella":"marcela@navawilson.law","suganya argeen":"suganya@navawilson.law","jahanvi rana":"jahanvi@navawilson.law","abishan thuraiaiya":"abishan@navawilson.law"};
  return roster[name.trim().toLowerCase().replace(/\s+/g," ")]??"";
}
