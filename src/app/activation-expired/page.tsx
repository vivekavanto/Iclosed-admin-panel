type Props = {
  searchParams: Promise<{ reason?: string }>;
};

const REASON_COPY: Record<string, { title: string; body: string }> = {
  expired: {
    title: "This link has expired",
    body: "Your activation link is more than 7 days old. Please request a new one from your iClosed advisor or use the Forgot Password option on the sign-in page.",
  },
  used: {
    title: "This link has already been used",
    body: "Your account is already activated. If you don't remember your password, use the Forgot Password option on the sign-in page to reset it.",
  },
  missing: {
    title: "This link is no longer valid",
    body: "The activation link couldn't be recognised. It may have been copied incorrectly. Please request a new one from your iClosed advisor.",
  },
  error: {
    title: "Something went wrong",
    body: "We couldn't validate your activation link. Please try again, or contact your iClosed advisor for a fresh invitation.",
  },
};

export default async function ActivationExpiredPage({ searchParams }: Props) {
  const { reason } = await searchParams;
  const copy = REASON_COPY[reason ?? ""] ?? REASON_COPY.missing;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
        background: "#f9fafb",
        color: "#111827",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          background: "#ffffff",
          padding: "32px",
          borderRadius: 12,
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        }}
      >
        <h1 style={{ margin: "0 0 12px 0", fontSize: 22, fontWeight: 700 }}>
          {copy.title}
        </h1>
        <p style={{ margin: "0 0 20px 0", fontSize: 15, lineHeight: 1.6 }}>
          {copy.body}
        </p>
        <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>
          iClosed by Nava Wilson
        </p>
      </div>
    </main>
  );
}
