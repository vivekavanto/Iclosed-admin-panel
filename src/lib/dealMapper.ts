import { Deal } from "@/types";

// ARC-005: single raw→Deal mapper shared by the deal list and the deal detail
// page, so the API field / column-alias mapping (fileNumber ?? file_number,
// etc.) lives in ONE place. Maps the core Deal shape; the list page spreads this
// and adds its extra list-only fields (co-party names, lawyer/clerk, address
// parts, …).
export function toDeal(d: any): Deal {
  return {
    id: d.id,
    fileNumber: d.fileNumber ?? d.file_number ?? "",
    client: d.client ?? {
      id: "",
      firstName: "",
      lastName: d.client_last_name ?? "",
      email: "",
      phone: "",
    },
    type: d.type,
    status: d.status,
    propertyAddress: d.propertyAddress ?? d.property_address ?? "",
    sellingPropertyAddress:
      d.sellingPropertyAddress ?? d.selling_property_address ?? "",
    closingDate: d.closingDate ?? d.closing_date ?? "",
    openingDate: d.openingDate ?? d.opening_date,
    requisitionDate: d.requisitionDate ?? d.requisition_date,
    price: d.price ?? 0,
    progress: d.progress ?? 0,
    tasks: d.tasks ?? [],
    milestones: d.milestones ?? [],
    documents: d.documents ?? [],
    notes: d.notes ?? [],
  };
}
