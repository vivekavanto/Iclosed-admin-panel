import { redirect } from "next/navigation";

export default function Home() {
  // Always enter through the authenticated, module-aware route gate.
  redirect("/admin/dashboard");
}
