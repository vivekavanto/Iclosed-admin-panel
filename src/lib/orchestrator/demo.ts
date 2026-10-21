import type { Matter } from "./model";

const specs = [
  ["26P-0901", "18 Maple Grove, Toronto", "Alex & Jamie Morgan", "Marcela Pitella", "2026-10-21", "purchase"],
  ["26S-0902", "42 Cedar Lane, Markham", "Taylor Chen", "Suganya Argeen", "2026-10-23", "sale"],
  ["26R-0903", "306–8 Harbour Way, Toronto", "Jordan Patel", "Jahanvi Rana", "2026-10-28", "refinance"],
  ["26P-0904", "7 Willow Court, Ajax", "Casey & Riley Lee", "Abishan Thuraiaiya", "2026-11-02", "purchase"],
  ["26P-0905", "91 Oak Avenue, Vaughan", "Avery Singh", "Marcela Pitella", "2026-11-12", "purchase"],
  ["26S-0906", "24 Birch Street, Pickering", "Cameron Brooks", "Suganya Argeen", "2026-11-19", "sale"],
  ["26R-0907", "56 Meadow Road, Brampton", "Robin Ellis", "Jahanvi Rana", "2026-12-04", "refinance"],
  ["26P-0908", "11 Park Crescent, Whitby", "Sam Rivera", "Marcela Pitella", "2026-12-17", "purchase"],
];
export const demoMatters: Matter[] = specs.map(([number, address, clients, clerk, closingDate, type]) => ({
  id: `demo:${number}`, number, address, clients, clerk, closingDate, type: type as Matter["type"],
  firm: "navawilson", name: `${type} of ${address}`, lawyer: "Kubeskaran Navaratnam",
  clientEmail: "client@example.com", clientPhone: "", openingDate: "2026-10-01", status: "active",
  auditReport: ["26P-0901", "26S-0902"].includes(number) ? { documentId: `preview-${number}`, url: "#preview-audit-report", verifiedAt: "2026-10-20T16:00:00Z" } : undefined,
  closerUrl: null, driveFolderId: null, sourceDate: "2026-10-20", sourcePresent: true,
}));
