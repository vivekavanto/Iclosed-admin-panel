import { createSign } from "node:crypto";

export interface DriveItem { id: string; name: string; mimeType: string; parents?: string[]; size?: string; modifiedTime?: string; webViewLink?: string; }
const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
export function normalizeGooglePrivateKey(raw: string) {
  const normalized = raw.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
  const pem = /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/.exec(normalized)?.[0];
  if (!pem) throw new Error("The Google service-account private key is not a valid PEM value.");
  return pem + "\n";
}

async function readToken() {
  const config = process.env.ORCHESTRATOR_GOOGLE_SERVICE_ACCOUNT_JSON;
  const account = config ? JSON.parse(config) : { client_email: process.env.GOOGLE_SA_EMAIL, private_key: process.env.GOOGLE_SA_PRIVATE_KEY?.replace(/\\n/g, "\n") };
  if (typeof account.client_email !== "string" || typeof account.private_key !== "string") throw new Error("Google Drive connection is not configured.");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope: "https://www.googleapis.com/auth/drive.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const signer = createSign("RSA-SHA256"); signer.update(unsigned);
  let signature: string;
  try { signature = signer.sign(normalizeGooglePrivateKey(account.private_key), "base64url"); }
  catch { throw new Error("The Google service-account private key could not be loaded."); }
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(20_000), cache: "no-store",
  });
  if (!response.ok) throw new Error("Google service-account authentication failed.");
  const result = await response.json();
  if (typeof result.access_token !== "string") throw new Error("Google authentication returned no token.");
  return result.access_token as string;
}

export const safeDriveId = (id: string) => /^[A-Za-z0-9_-]+$/.test(id);
export class ReadOnlyDrive {
  private token: string;
  private constructor(token: string) { this.token = token; }
  static async connect() { return new ReadOnlyDrive(await readToken()); }
  private async request(path: string, params: URLSearchParams) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/${path}?${params}`, {
      headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(25_000), cache: "no-store",
    });
    if (!response.ok) {
      const details = await response.json().catch(() => null);
      const reasons = details?.error?.errors;
      if (Array.isArray(reasons) && reasons.some((item: { reason?: string }) => item.reason === "accessNotConfigured")) {
        throw new Error("Google Drive API is disabled in the service account’s Google Cloud project. Enable the API before checking folder access.");
      }
      throw new Error(response.status === 403 || response.status === 404 ? "The connected Google service account cannot access this Drive location." : "Google Drive request failed.");
    }
    return response;
  }
  async metadata(id: string): Promise<DriveItem> {
    if (!safeDriveId(id)) throw new Error("Invalid Drive identity.");
    return (await this.request(`files/${id}`, new URLSearchParams({ fields: "id,name,mimeType,parents,size,modifiedTime,webViewLink,trashed", supportsAllDrives: "true" }))).json();
  }
  async list(query: string): Promise<DriveItem[]> {
    const files: DriveItem[] = [], seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: query, pageSize: "100", fields: "nextPageToken,files(id,name,mimeType,parents,size,modifiedTime,webViewLink)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await (await this.request("files", params)).json();
      if (!Array.isArray(data.files)) throw new Error("Incomplete Google folder response.");
      files.push(...data.files);
      pageToken = data.nextPageToken;
      if (pageToken && seen.has(pageToken)) throw new Error("Google folder pagination did not complete.");
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return files;
  }
  async children(id: string, foldersOnly = false) {
    if (!safeDriveId(id)) throw new Error("Invalid Drive identity.");
    return this.list(`'${id}' in parents and trashed=false${foldersOnly ? " and mimeType='application/vnd.google-apps.folder'" : ""}`);
  }
  async pdf(file: DriveItem) {
    const expected = Number(file.size), limit = 50_000_000;
    if (!safeDriveId(file.id) || file.mimeType !== "application/pdf" || !Number.isSafeInteger(expected) || expected <= 0 || expected > limit) throw new Error("Invalid or oversized signing PDF.");
    const response = await this.request(`files/${file.id}`, new URLSearchParams({ alt: "media", supportsAllDrives: "true" }));
    if (!response.body) throw new Error("Signing PDF response is empty.");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit || length > expected) throw new Error("Signing PDF size changed during download."); chunks.push(value); } }
    catch(error) { await reader.cancel().catch(()=>{}); throw error; }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== expected || bytes.subarray(0,5).toString("ascii") !== "%PDF-") throw new Error("Signing PDF signature or size mismatch.");
    return bytes;
  }
  async csv(file: DriveItem) {
    if (!safeDriveId(file.id) || file.mimeType !== "text/csv" || !Number(file.size) || Number(file.size) > 10_000_000) throw new Error("Invalid or oversized CSV extract.");
    const response = await this.request(`files/${file.id}`, new URLSearchParams({ alt: "media", supportsAllDrives: "true" }));
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== Number(file.size)) throw new Error("Extract size mismatch; wait for a complete upload.");
    return bytes.toString("utf8");
  }
}
