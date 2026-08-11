"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { isPublicPath } from "@/lib/publicRoutes";
import type { User } from "@supabase/supabase-js";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

// auth.users is shared with the customer portal, so a valid session is
// not proof of admin access. Only users tagged with role="admin" in
// app_metadata are allowed in.
function isAdmin(user: User | null): boolean {
  return user?.app_metadata?.role === "admin";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  // The login page and the public surface are the two places an unauthenticated
  // visitor is SUPPOSED to be, so neither may be bounced to /admin/login.
  const staysWithoutSession = pathname === "/admin/login" || isPublicPath(pathname);

  useEffect(() => {
    let cancelled = false;

    const verifyAndSet = async (sessionUser: User | null) => {
      if (!sessionUser) {
        if (!cancelled) setUser(null);
        return;
      }
      if (!isAdmin(sessionUser)) {
        // A non-admin (customer) somehow has a session here. Force
        // sign-out so they're bounced back to /admin/login.
        await supabase.auth.signOut();
        if (!cancelled) setUser(null);
        return;
      }
      if (!cancelled) setUser(sessionUser);
    };

    // Initial session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      await verifyAndSet(session?.user ?? null);
      if (!cancelled) setLoading(false);
    });

    // Future auth changes (login/logout in another tab, token refresh, etc.)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      verifyAndSet(session?.user ?? null).then(() => {
        if (!cancelled && !session && !staysWithoutSession) {
          router.push("/admin/login");
        }
      });
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [router, staysWithoutSession]);

  // Redirect to login if not authenticated (or not authorized as admin)
  useEffect(() => {
    if (!loading && !user && !staysWithoutSession) {
      router.push("/admin/login");
    }
  }, [loading, user, staysWithoutSession, router]);

  const signOut = async () => {
    await supabase.auth.signOut();
    router.push("/admin/login");
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
