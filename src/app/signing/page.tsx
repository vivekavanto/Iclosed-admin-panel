import SigningLawyerList from "@/components/signing/SigningLawyerList";

// Public page (outside /admin — see src/middleware.ts): /signing
// "Choose your lawyer" landing page for when a client doesn't already have a
// specific /signing/[initials] link.
export default function SigningLandingPage() {
  return <SigningLawyerList />;
}
