import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export default async function AppHomePage() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (session.user.role === "ADMIN") redirect("/admin");
  redirect("/app/projects");
}
