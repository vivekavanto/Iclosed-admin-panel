import { AUDIT_MAILBOX, auditGoogleJson, auditGoogleToken } from "./google-audit-auth.ts";
const base = "https://gmail.googleapis.com/gmail/v1/users/me";
const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,256}$/.test(id);
export class AuditMailbox {
  private readonly token: string;
  private constructor(token: string) { this.token = token; }
  static async connect() {
    const token = await auditGoogleToken("gmailRead");
    const profile = await auditGoogleJson(`${base}/profile`, token);
    if (profile.emailAddress?.toLowerCase() !== AUDIT_MAILBOX) throw new Error("Audit mailbox identity mismatch. No messages were read.");
    return new AuditMailbox(token);
  }
  async search(query: string, pageToken?: string) {
    if (!query.trim() || query.length > 1500) throw new Error("A bounded matter-specific email search is required.");
    const params = new URLSearchParams({ q: `(${query}) -in:spam -in:trash`, maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    return auditGoogleJson(`${base}/messages?${params}`, this.token);
  }
  async thread(id: string) {
    if (!safeId(id)) throw new Error("Invalid email thread identity.");
    return auditGoogleJson(`${base}/threads/${id}?format=full`, this.token);
  }
  async attachment(messageId: string, attachmentId: string) {
    if (!safeId(messageId) || !/^[a-zA-Z0-9_-]{1,2048}$/.test(attachmentId)) throw new Error("Invalid email attachment identity.");
    return auditGoogleJson(`${base}/messages/${messageId}/attachments/${attachmentId}`, this.token);
  }
  // Deliberately no send, draft, modify, label, delete or mark-read methods.
}
