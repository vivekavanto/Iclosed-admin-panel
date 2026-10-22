"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { canSignIn } from "@/lib/staffAccess";
import { isPublicRoute } from "@/lib/publicRoutes";
import type { User } from "@supabase/supabase-js";
import { watchAuthUser } from "@/lib/watchAuthUser";

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
// not proof of staff access. Verified staff eligibility and server-owned
// module assignments are checked separately.
function isStaff(user: User | null): boolean {
  return canSignIn(user);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    return watchAuthUser(supabase.auth, verifiedUser => {
      setUser(isStaff(verifiedUser) ? verifiedUser : null);
      setLoading(false);
    });
  }, [pathname]);

  // Redirect to login if not authenticated (or not authorized as admin).
  // Public pages (src/lib/publicRoutes.ts) are exempt: a visitor there has no
  // session by design, and bouncing them to /admin/login is the one thing that
  // page must never do.
  useEffect(() => {
    if (!loading && !user && !["/admin/login", "/admin/signup", "/admin/auth/confirm"].includes(pathname) && !isPublicRoute(pathname)) {
      router.push("/admin/login");
    }
  }, [loading, user, pathname, router]);

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
