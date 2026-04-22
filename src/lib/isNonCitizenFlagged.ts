type LeadLike = {
  citizenship_status?: string | null;
  citizenshipStatus?: string | null;
};

export function isNonCitizenFlagged(lead: LeadLike | null | undefined): boolean {
  const status = (lead?.citizenship_status ?? lead?.citizenshipStatus ?? "").toLowerCase();
  if (!status.includes("non")) return false;
  return status.includes("unsure") || status.includes("citizen");
}

export const NON_CITIZEN_FLAG_LABEL = "NON-CITIZEN / UNSURE";
export const NON_CITIZEN_FLAG_TOOLTIP =
  "Client self-identified as non-citizen or unsure — review required.";
