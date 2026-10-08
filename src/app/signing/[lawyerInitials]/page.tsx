import SigningBookingPage, { type SigningPrefill } from "@/components/signing/SigningBookingPage";

// Public page (outside /admin — see src/middleware.ts), e.g. /signing/AT.
// Optional query params prefill the form (the portal links here with the
// logged-in client's details): name, email, phone, address, closingDate,
// dealType (purchase|sale), file.
export default async function LawyerSigningPage({
  params,
  searchParams,
}: {
  params: Promise<{ lawyerInitials: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { lawyerInitials } = await params;
  const sp = await searchParams;
  const pick = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim().slice(0, 200) || undefined;
  };
  const dealType = pick("dealType")?.toLowerCase();
  const prefill: SigningPrefill = {
    clientName: pick("name"),
    clientEmail: pick("email"),
    clientPhone: pick("phone"),
    propertyAddress: pick("address"),
    closingDate: /^\d{4}-\d{2}-\d{2}$/.test(pick("closingDate") ?? "") ? pick("closingDate") : undefined,
    dealType: dealType === "purchase" || dealType === "sale" ? dealType : undefined,
    fileNumber: pick("file"),
  };
  return <SigningBookingPage lawyerInitials={lawyerInitials} prefill={prefill} />;
}
