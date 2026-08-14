import { redirect } from "next/navigation";

// The calculator moved to /closing-cost-calculator, which serves staff and the
// clerks the link is shared with from ONE page — see that route for why.
//
// This stays behind as a redirect so the sidebar entry people have used, and any
// bookmark of it, still lands somewhere. Delete once nobody is reaching for the
// old address.
export default function CalculatorPage() {
  redirect("/closing-cost-calculator");
}
