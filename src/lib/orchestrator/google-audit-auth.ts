import { createSign } from "node:crypto";
import { normalizeGooglePrivateKey } from "./google-drive.ts";

import { AUDIT_MAILBOX, GMAIL_READ_SCOPE } from "./google-audit-constants.ts";
export { AUDIT_MAILBOX, GMAIL_READ_SCOPE } from "./google-audit-constants.ts";
import { readMailboxConnection } from "./mailbox-oauth.ts";
export type AuditGooglePurpose = "docsRead" | "docsWrite" | "gmailRead";
const scopes = {
  docsRead: "https://www.googleapis.com/auth/documents.readonly https://www.googleapis.com/auth/drive.readonly",
  docsWrite: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive",
  gmailRead: GMAIL_READ_SCOPE,
};
async function tokenResponse(body: URLSearchParams): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const result = await response.json();
  if (!response.ok || typeof result.access_token !== "string") {
    if (result.error === "unauthorized_client") throw new Error("Google has not authorized this service account for read-only access to the audit mailbox.");
    throw new Error("Audit Google authentication failed. Verify the configured credential and authorization.");
  }
  return result.access_token;
}
export async function auditGoogleToken(purpose: AuditGooglePurpose): Promise<string> {
  if (typeof window !== "undefined") throw new Error("Audit credentials are server-only.");
  if (purpose === "docsWrite" && process.env.ORCHESTRATOR_AUDIT_WRITES_ENABLED !== "true") throw new Error("Audit report writing is not enabled.");
  if (purpose === "gmailRead" && process.env.ORCHESTRATOR_GMAIL_REFRESH_TOKEN) {
    const clientId = process.env.ORCHESTRATOR_GMAIL_CLIENT_ID, secret = process.env.ORCHESTRATOR_GMAIL_CLIENT_SECRET;
    if (!clientId || !secret) throw new Error("Audit mailbox OAuth client is not configured.");
    return tokenResponse(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: secret, refresh_token: process.env.ORCHESTRATOR_GMAIL_REFRESH_TOKEN }));
  }
  if (purpose === "gmailRead") {
    const saved=await readMailboxConnection();
    if(saved) {
      const clientId=process.env.ORCHESTRATOR_GMAIL_CLIENT_ID,secret=process.env.ORCHESTRATOR_GMAIL_CLIENT_SECRET;
      if(!clientId||!secret||saved.clientId!==clientId||saved.email!==AUDIT_MAILBOX||saved.scope!==GMAIL_READ_SCOPE)throw new Error("Saved mailbox authorization does not match this connection. Reconnect it.");
      return tokenResponse(new URLSearchParams({grant_type:"refresh_token",client_id:clientId,client_secret:secret,refresh_token:saved.refreshToken}));
    }
  }
  // Mailbox authorization is separate from Drive access. Never silently impersonate with the Drive account.
  const raw = purpose === "gmailRead" ? process.env.ORCHESTRATOR_GMAIL_SERVICE_ACCOUNT_JSON : purpose === "docsWrite" ? process.env.ORCHESTRATOR_GOOGLE_WRITER_SERVICE_ACCOUNT_JSON : process.env.ORCHESTRATOR_GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error(purpose === "gmailRead" ? "Website audit mailbox access is not configured." : "Audit Google service account is not configured.");
  const account = JSON.parse(raw);
  if (typeof account.client_email !== "string" || typeof account.private_key !== "string") throw new Error("Invalid audit service-account configuration.");
  const now = Math.floor(Date.now() / 1000), encode = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope: scopes[purpose], aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600, ...(purpose === "gmailRead" ? { sub: AUDIT_MAILBOX } : {}) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(normalizeGooglePrivateKey(account.private_key), "base64url");
  return tokenResponse(new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }));
}
export async function auditGoogleJson(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) }, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (body?.error?.errors?.some((item: {reason?: string}) => item.reason === "accessNotConfigured")) throw new Error("The required Google API is disabled in the configured project.");
    if (response.status === 409 || response.status === 412 || body?.error?.status === "FAILED_PRECONDITION") throw new Error("The report changed during the audit. Read the current report before retrying.");
    throw new Error(`Google audit connection request failed (${response.status}). Verify provider state before retrying a write.`);
  }
  return body;
}
