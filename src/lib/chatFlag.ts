// The client chat (Messages inbox, Open chat button, bell link) is hidden unless
// NEXT_PUBLIC_CHAT_ENABLED=true. It is inlined at build time, so redeploy (or
// restart the dev server) after changing it.
export const CHAT_ENABLED = process.env.NEXT_PUBLIC_CHAT_ENABLED === "true";
