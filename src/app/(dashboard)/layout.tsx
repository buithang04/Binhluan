import { DashboardShell } from "@/components/DashboardShell";

/**
 * Auth do middleware. Shell dùng client session — soft-nav không chờ getServerSession.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardShell>{children}</DashboardShell>;
}
