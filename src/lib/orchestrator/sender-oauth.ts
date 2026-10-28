import {hostedDocumentsEnabled,hostedConfiguration} from "./hosted/document.ts";
import {readConnectionSecret,saveConnectionSecret,consumeConnectionSecret} from "./hosted/connection.ts";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { localStateDirectory } from "./local-store.ts";
import { AUDIT_MAILBOX } from "./google-audit-constants.ts";

export const SENDER_SCOPES="openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send";
export const SENDER_STATE_COOKIE = "orch_send_oauth";
export const SENDER_CALLBACK_PATH = "/api/admin/legal-assistant/mailbox/callback";
const MAX_AGE_MS = 10 * 60_000;
interface Attempt { operatorId: string; verifier: string; redirectUri: string; clientId: string; expiresAt: number; }
interface Connection { email: string; clientId: string; refreshToken: string; scope: string; connectedAt: string; connectedBy: string; }

export function senderAppOrigin() {
  const url = new URL(process.env.ORCHESTRATOR_APP_URL || (process.env.NODE_ENV !== "production" ? "http://localhost:3004" : ""));
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw new Error("Invalid Orchestrator connection origin.");
  return url.origin;
}
export function senderClientConfig() {
  const clientId = process.env.ORCHESTRATOR_GMAIL_CLIENT_ID, clientSecret = process.env.ORCHESTRATOR_GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth web client is not configured.");
  return {clientId, clientSecret, redirectUri: senderAppOrigin() + SENDER_CALLBACK_PATH};
}
async function directory() {
  if(hostedDocumentsEnabled()){hostedConfiguration();if(Buffer.from(process.env.ORCHESTRATOR_TOKEN_ENCRYPTION_KEY??"","base64").length!==32)throw Error("A stable hosted token encryption key is required.");return "hosted-sender";}
  const root = localStateDirectory();
  if (!root || process.env.NODE_ENV === "production") throw new Error("Secure mailbox token storage is not configured for this environment.");
  const dir = path.join(root, "sender-connection"); await mkdir(dir, { recursive:true, mode:0o700 }); return dir;
}
async function encryptionKey(dir: string) {
  if (process.env.ORCHESTRATOR_TOKEN_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.ORCHESTRATOR_TOKEN_ENCRYPTION_KEY, "base64"); if(key.length!==32)throw new Error("Invalid mailbox encryption key."); return key;
  }
  if(hostedDocumentsEnabled())throw Error("A stable hosted token encryption key is required.");
  const file=path.join(dir,"encryption.key");
  try { const key=await readFile(file);if(key.length!==32)throw new Error("Invalid mailbox encryption key.");return key; }
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
    const key=randomBytes(32);try {await writeFile(file,key,{mode:0o600,flag:"wx"});return key;}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;const existing=await readFile(file);if(existing.length!==32)throw new Error("Invalid mailbox encryption key.");return existing;}
  }
}
async function seal(dir: string, data: unknown) {
  const nonce=randomBytes(12), cipher=createCipheriv("aes-256-gcm",await encryptionKey(dir),nonce);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(data),"utf8"),cipher.final()]);
  return JSON.stringify({version:1,nonce:nonce.toString("base64"),tag:cipher.getAuthTag().toString("base64"),data:encrypted.toString("base64")});
}
async function unseal<T>(dir: string, raw: string): Promise<T> {
  const envelope=JSON.parse(raw);if(envelope.version!==1)throw new Error("Unsupported mailbox secret format.");
  const decipher=createDecipheriv("aes-256-gcm",await encryptionKey(dir),Buffer.from(envelope.nonce,"base64"));decipher.setAuthTag(Buffer.from(envelope.tag,"base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,"base64")),decipher.final()]).toString("utf8"));
}
export function validSenderState(expected: string | undefined, received: string | null) {
  if(!expected||!received||!/^[A-Za-z0-9_-]{43}$/.test(expected)||!/^[A-Za-z0-9_-]{43}$/.test(received))return false;
  return timingSafeEqual(Buffer.from(expected),Buffer.from(received));
}
const attemptName=(state: string)=>`state-${createHash("sha256").update(state).digest("hex")}.json`;
export async function beginSenderOAuth(operatorId: string) {
  if(!operatorId)throw new Error("An authenticated administrator is required.");
  const config=senderClientConfig(),dir=await directory(),state=randomBytes(32).toString("base64url"),verifier=randomBytes(48).toString("base64url");
  const attempt:Attempt={operatorId,verifier,redirectUri:config.redirectUri,clientId:config.clientId,expiresAt:Date.now()+MAX_AGE_MS};
  const envelope=await seal(dir,attempt);if(hostedDocumentsEnabled())await saveConnectionSecret("sender",attemptName(state),envelope,true);else await writeFile(path.join(dir,attemptName(state)),envelope,{mode:0o600,flag:"wx"});
  const query=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:"code",scope:SENDER_SCOPES,state,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256",access_type:"offline",prompt:"consent select_account",include_granted_scopes:"false",login_hint:AUDIT_MAILBOX,hd:"navawilson.law"});
  return {state,url:`https://accounts.google.com/o/oauth2/v2/auth?${query}`};
}
async function consumeAttempt(operatorId: string, state: string) {
  const dir=await directory();
  if(hostedDocumentsEnabled()){const raw=await consumeConnectionSecret("sender",attemptName(state));const attempt=await unseal<Attempt>(dir,raw);if(attempt.expiresAt<Date.now()||attempt.operatorId!==operatorId)throw Error("Authorization attempt expired or belongs to another administrator.");const config=senderClientConfig();if(attempt.clientId!==config.clientId||attempt.redirectUri!==config.redirectUri)throw Error("OAuth client configuration changed. Start again.");return attempt;}
  const pending=path.join(dir,attemptName(state)),used=path.join(dir,`used-${randomUUID()}.json`);
  // Atomic claim: a second callback cannot exchange the same authorization code.
  try {await rename(pending,used);}catch{throw new Error("Authorization attempt expired or was already used.");}
  try {const attempt=await unseal<Attempt>(dir,await readFile(used,"utf8"));if(attempt.expiresAt<Date.now()||attempt.operatorId!==operatorId)throw new Error("Authorization attempt expired or belongs to another administrator.");const config=senderClientConfig();if(attempt.clientId!==config.clientId||attempt.redirectUri!==config.redirectUri)throw new Error("OAuth client configuration changed. Start again.");return attempt;}finally{await rm(used,{force:true});}
}
async function storeConnection(connection:Connection) {
  const dir=await directory();if(hostedDocumentsEnabled()){await saveConnectionSecret("sender","connection",await seal(dir,connection));return;}const temporary=path.join(dir,`connection-${randomUUID()}.tmp`);
  try {await writeFile(temporary,await seal(dir,connection),{mode:0o600,flag:"wx"});await rename(temporary,path.join(dir,"connection.json"));}finally{await rm(temporary,{force:true});}
}
export async function readSenderConnection(): Promise<Connection|null> {
  if(hostedDocumentsEnabled()){const dir=await directory(),raw=await readConnectionSecret("sender","connection");return raw?unseal<Connection>(dir,raw):null;}
  if(!process.env.ORCHESTRATOR_LOCAL_STATE_DIR)return null;
  const dir=await directory();try {return await unseal<Connection>(dir,await readFile(path.join(dir,"connection.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw new Error("Saved mailbox connection cannot be read securely. Reconnect the mailbox.");}
}
export async function senderOAuthReadiness() {
  let configured=false,callback:string|null=null,error:string|null=null;
  try {const config=senderClientConfig();callback=config.redirectUri;await directory();configured=true;}catch(e){error=e instanceof Error?e.message:"Mailbox connection setup is incomplete.";try{callback=senderAppOrigin()+SENDER_CALLBACK_PATH;}catch{ /* No untrusted origin fallback. */ }}
  const connection=await readSenderConnection().catch(()=>null);
  return {configured,callback,error,connected:!!connection,email:connection?.email??null,connectedAt:connection?.connectedAt??null};
}
export async function finishSenderOAuth(input:{operatorId:string;cookieState?:string;returnedState:string|null;code:string|null;denied?:boolean}) {
  if(!validSenderState(input.cookieState,input.returnedState))throw new Error("Authorization state is missing or invalid. Start again.");
  const attempt=await consumeAttempt(input.operatorId,input.returnedState!);
  if(input.denied)throw new Error("Google authorization was cancelled.");
  if(!input.code||input.code.length>4096)throw new Error("Google returned no valid authorization code.");
  const config=senderClientConfig();
  const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",body:new URLSearchParams({grant_type:"authorization_code",client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:attempt.redirectUri,code:input.code,code_verifier:attempt.verifier}),cache:"no-store",signal:AbortSignal.timeout(20_000)});
  const tokens=await response.json();
  if(!response.ok||typeof tokens.access_token!=="string"||typeof tokens.refresh_token!=="string")throw new Error("Google did not provide a reusable mailbox authorization. Start again and approve Gmail sending access.");
  const granted=new Set(String(tokens.scope??"").split(/\s+/).filter(Boolean).map(scope=>scope==="email"?"https://www.googleapis.com/auth/userinfo.email":scope));
  if(granted.size!==3||SENDER_SCOPES.split(" ").some(scope=>!granted.has(scope)))throw new Error("Google did not grant exactly the requested Gmail sending and identity permissions. No connection was saved.");
  const profileResponse=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{Authorization:`Bearer ${tokens.access_token}`},cache:"no-store",signal:AbortSignal.timeout(20_000)});
  const profile=await profileResponse.json();
  if(!profileResponse.ok||profile.email?.toLowerCase()!==AUDIT_MAILBOX||profile.email_verified!==true)throw new Error("Please authorize communication@navawilson.law. No connection was saved for the selected account.");
  await storeConnection({email:AUDIT_MAILBOX,clientId:config.clientId,refreshToken:tokens.refresh_token,scope:SENDER_SCOPES,connectedAt:new Date().toISOString(),connectedBy:input.operatorId});
  return {email:AUDIT_MAILBOX};
}

export async function senderAccessToken(){
 const config=senderClientConfig(),saved=await readSenderConnection();
 if(!saved||saved.email!==AUDIT_MAILBOX||saved.clientId!==config.clientId||saved.scope!==SENDER_SCOPES)throw Error("Connect the Gmail sender before sending email.");
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:config.clientId,client_secret:config.clientSecret,refresh_token:saved.refreshToken}),signal:AbortSignal.timeout(20000),cache:'no-store'});
 const token=await response.json();if(!response.ok||typeof token.access_token!=='string')throw Error('Gmail sending authorization needs reconnection.');
 const profileResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(20000),cache:'no-store'});const profile=await profileResponse.json();if(!profileResponse.ok||profile.email?.toLowerCase()!==AUDIT_MAILBOX||profile.email_verified!==true)throw Error('Gmail sender identity could not be verified.');
 return token.access_token as string;
}
