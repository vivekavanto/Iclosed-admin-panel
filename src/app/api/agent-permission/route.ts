import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { rateLimitOk, requestIp } from "@/lib/rateLimit";
import { escapeHtml } from "@/lib/renderEmailTemplate";
import { getLeadFirm } from "@/lib/leadFirm";
import { getFirm, type FirmProfile } from "@/lib/firms";
import { recordAudit } from "@/lib/recordAudit";
import { answerPermissionRequest, findPermissionRequest, type PermissionRequest } from "@/lib/agentTaskPermission";
import { AGENT_PERMISSION_PATH } from "@/lib/sendAgentPermissionEmail";

// Public (outside /api/admin): the emailed token is the credential. GET never records
// an answer; it auto-posts from the browser so mail scanners can't accept.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(firm: FirmProfile, origin: string, heading: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(heading)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 40px 16px; background: #f8fafc; color: #0f172a; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
  .card { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 14px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 1px 3px rgba(15,23,42,.06); }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p, li { color: #475569; }
  ul { padding-left: 20px; }
  form { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
  button { font: inherit; font-weight: 600; border-radius: 8px; padding: 10px 20px; cursor: pointer; }
  .accept { background: #C10007; color: #fff; border: 0; }
  .decline { background: #fff; color: #334155; border: 1px solid #cbd5e1; }
  .foot { margin-top: 28px; font-size: 13px; color: #64748b; }
  img.logo { display: block; margin-bottom: 24px; }
</style>
</head>
<body>
  <div class="card">
    <img class="logo" src="${escapeHtml(origin + firm.logoPath)}" alt="${escapeHtml(firm.label)}" width="120" />
    <h1>${escapeHtml(heading)}</h1>
    ${body}
    <p class="foot">${escapeHtml(firm.label)}</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}

async function describe(request: PermissionRequest) {
  const [{ data: partner }, { data: deal }, firm] = await Promise.all([
    supabaseAdmin.from("partners").select("agent_name, brokerage_name").eq("id", request.partnerId).maybeSingle(),
    supabaseAdmin.from("deals").select("property_address, selling_property_address").eq("lead_id", request.rootLeadId).eq("is_deleted", false).maybeSingle(),
    getLeadFirm(request.rootLeadId),
  ]);
  const agent = partner?.agent_name?.trim() || "Your agent";
  return {
    firm,
    agent,
    agentLine: escapeHtml(agent) + (partner?.brokerage_name ? ` of ${escapeHtml(partner.brokerage_name)}` : ""),
    property: deal?.property_address || deal?.selling_property_address || null,
  };
}

async function resolve(req: Request, token: string) {
  const origin = new URL(req.url).origin;
  const fallback = getFirm(null);
  if (!(await rateLimitOk(`agent-permission:ip:${requestIp(req)}`, 30, 600))) {
    return { error: page(fallback, origin, "Too many attempts", "<p>Please wait a few minutes and open the link from your email again.</p>", 429) };
  }
  const found = await findPermissionRequest(token);
  if (!found.ok) {
    return {
      error: page(
        fallback,
        origin,
        found.reason === "expired" ? "This link has expired" : "This link is no longer valid",
        "<p>This request may already have been answered, or replaced by a newer one. Your agent can send you a new request.</p>",
        410,
      ),
    };
  }
  return { origin, request: found.request };
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  try {
    const r = await resolve(req, token);
    if ("error" in r) return r.error;
    const d = await describe(r.request);
    const decision = new URL(req.url).searchParams.get("decision");
    if (decision === "accept" || decision === "decline") {
      const accept = decision === "accept";
      return page(
        d.firm,
        r.origin,
        accept ? "Saving your answer…" : "Declining the request…",
        `<form method="post" action="${AGENT_PERMISSION_PATH}">` +
          `<input type="hidden" name="token" value="${escapeHtml(token)}" />` +
          `<input type="hidden" name="decision" value="${decision}" />` +
          `<noscript><p>Please confirm to continue.</p><button class="${accept ? "accept" : "decline"}" type="submit">${accept ? "Accept" : "Decline"}</button></noscript>` +
          `</form>` +
          `<script>document.forms[0].submit();</script>`,
      );
    }
    return page(
      d.firm,
      r.origin,
      `${d.agent} is asking to help with your file`,
      `<p><strong>${d.agentLine}</strong> would like to complete tasks on your file${d.property ? ` for <strong>${escapeHtml(d.property)}</strong>` : ""}.</p>` +
        `<p>If you accept, your agent can:</p>` +
        `<ul><li>fill in your task forms for you</li><li>upload documents to your tasks</li></ul>` +
        `<p>Everything they enter shows on your dashboard. You can ask us to remove their access at any time.</p>` +
        `<form method="post" action="${AGENT_PERMISSION_PATH}">` +
        `<input type="hidden" name="token" value="${escapeHtml(token)}" />` +
        `<button class="accept" name="decision" value="accept" type="submit">Accept</button>` +
        `<button class="decline" name="decision" value="decline" type="submit">Decline</button>` +
        `</form>`,
    );
  } catch (err) {
    logger.error("[agent-permission] load failed:", err);
    return page(getFirm(null), new URL(req.url).origin, "Something went wrong", "<p>Please try the link again shortly.</p>", 500);
  }
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const token = String(form?.get("token") ?? "");
  const decision = String(form?.get("decision") ?? "");
  try {
    const r = await resolve(req, token);
    if ("error" in r) return r.error;
    if (decision !== "accept" && decision !== "decline") return page(getFirm(null), r.origin, "Please choose an option", "<p>Open the link from your email and choose Accept or Decline.</p>", 400);

    const accept = decision === "accept";
    await answerPermissionRequest(r.request, accept);
    await recordAudit({
      action: accept ? "partner.task_permission_granted" : "partner.task_permission_declined",
      actorEmail: r.request.email,
      actorUserId: null,
      resourceType: "lead",
      resourceId: r.request.rootLeadId,
      metadata: { partnerId: r.request.partnerId, via: "email_link" },
      req,
    });
    const d = await describe(r.request);
    return accept
      ? page(d.firm, r.origin, "Thanks, you're all set", `<p>${d.agentLine} can now complete tasks on your file. You can ask us to remove their access at any time.</p>`)
      : page(d.firm, r.origin, "Request declined", `<p>${d.agentLine} won't be able to complete tasks on your file. Nothing else has changed.</p>`);
  } catch (err) {
    logger.error("[agent-permission] answer failed:", err);
    return page(getFirm(null), new URL(req.url).origin, "Something went wrong", "<p>We couldn't save your answer. Please try the link again shortly.</p>", 500);
  }
}
