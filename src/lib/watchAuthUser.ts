import type { SupabaseClient, User } from "@supabase/supabase-js";

type Auth = Pick<SupabaseClient["auth"], "getUser" | "onAuthStateChange">;

/** Publish users verified by Auth, never the potentially stale token's user. */
export function watchAuthUser(auth: Auth, onUser: (user: User | null) => void): () => void {
  let stopped = false;
  let revision = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;

  async function load() {
    const requestRevision = ++revision;
    try {
      const { data, error } = await auth.getUser();
      if (!stopped && requestRevision === revision) onUser(error ? null : data.user);
    } catch {
      if (!stopped && requestRevision === revision) onUser(null);
    }
  }

  const { data: { subscription } } = auth.onAuthStateChange((event, session) => {
    // getUser() below owns the initial load. INITIAL_SESSION may arrive later
    // with old app_metadata from the existing access token after an owner edit.
    if (stopped || event === "INITIAL_SESSION") return;
    ++revision;
    clearTimeout(pending);
    if (!session) {
      onUser(null);
      return;
    }
    // Supabase holds its auth lock during this callback. Defer the new Auth
    // request until the callback returns, rather than deadlocking that lock.
    pending = setTimeout(() => { void load(); }, 0);
  });

  void load();
  return () => {
    stopped = true;
    ++revision;
    clearTimeout(pending);
    subscription.unsubscribe();
  };
}
