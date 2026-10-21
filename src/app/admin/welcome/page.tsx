"use client";
import { useAuth } from "@/lib/AuthProvider";
import { moduleIds } from "@/lib/staffAccess";
export default function WelcomePage() {
  const { user } = useAuth();
  return <section className="p-8"><h1 className="text-2xl font-semibold">Your account is ready</h1><p className="mt-3 text-slate-600">{moduleIds(user).length ? "Choose an available tab from the menu." : "Saru will assign the tabs you can access. Once access is granted, sign out and sign back in to refresh your menu."}</p></section>;
}
