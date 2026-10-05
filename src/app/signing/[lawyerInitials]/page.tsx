import SigningBookingPage from "@/components/signing/SigningBookingPage";

// Public page (outside /admin — see src/middleware.ts), e.g. /signing/AT.
export default async function LawyerSigningPage({
  params,
}: {
  params: Promise<{ lawyerInitials: string }>;
}) {
  const { lawyerInitials } = await params;
  return <SigningBookingPage lawyerInitials={lawyerInitials} />;
}
