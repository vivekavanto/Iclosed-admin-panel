import type { StepUpAnswer } from "@/components/StepUpProvider";

/**
 * Client-side helper for "log in as this client" (SEC-006).
 *
 * Asks the server for the link WITHOUT a password first. If the admin ticked
 * "don't ask me again" earlier in this login session, the server recognises the
 * remembered confirmation and answers straight away. Otherwise it replies
 * 401 + `stepUpRequired`, and only then do we show the password dialog and
 * retry with the answer.
 *
 * Throws StepUpCancelled when the admin dismisses the dialog, so callers can
 * back out quietly instead of showing an error.
 */

export class StepUpCancelled extends Error {
  constructor() {
    super("Step-up cancelled");
    this.name = "StepUpCancelled";
  }
}

type ImpersonationTarget = { email?: string | null; authUserId?: string | null };

/** Shows the password dialog; resolves null when the admin cancels. */
export type StepUpPrompt = (req: {
  subject?: string;
  canRemember?: boolean;
}) => Promise<StepUpAnswer | null>;

export async function requestImpersonationLink(
  target: ImpersonationTarget,
  promptForStepUp: StepUpPrompt,
  subject?: string,
): Promise<{ url: string }> {
  const post = async (answer?: StepUpAnswer) => {
    const res = await fetch("/api/admin/impersonate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(target.email ? { email: target.email } : {}),
        ...(target.authUserId ? { authUserId: target.authUserId } : {}),
        ...(answer
          ? { stepUpPassword: answer.password, rememberStepUp: answer.remember }
          : {}),
      }),
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  };

  let { res, json } = await post();

  if (res.status === 401 && json?.stepUpRequired) {
    const answer = await promptForStepUp({
      subject,
      canRemember: json.canRemember !== false,
    });
    if (!answer?.password) throw new StepUpCancelled();
    ({ res, json } = await post(answer));
  }

  if (!res.ok || !json?.url) {
    throw new Error(json?.error || "Failed to generate link");
  }
  return json as { url: string };
}
