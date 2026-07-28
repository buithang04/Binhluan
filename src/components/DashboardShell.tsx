"use client";

import { useSession } from "next-auth/react";
import { useRef, type ReactNode } from "react";
import { AppHeader } from "@/components/AppHeader";
import { AdminMobileNav, AdminSidebar } from "@/components/AdminSidebar";
import { UserMobileNav, UserSidebar } from "@/components/UserSidebar";

/**
 * Shell giữ sidebar theo role đã biết — không unmount khi session loading / soft-nav.
 * Auth do middleware.
 */
export function DashboardShell({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const cached = useRef<{ role?: string; email?: string | null }>({});

  const role = session?.user?.role;
  const email = session?.user?.email;
  if (role) {
    cached.current = { role, email };
  }

  // Giữ chrome cũ khi session đang load / refetch — tránh mất nút tab giữa chừng
  const effectiveRole =
    role ?? (status === "loading" ? cached.current.role : undefined);
  const effectiveEmail = email ?? cached.current.email;
  const isAdmin = effectiveRole === "ADMIN";

  if (!effectiveRole) {
    return (
      <div className="app-canvas app-shell">
        <aside className="admin-sidebar hidden md:block" aria-hidden />
        <div className="app-shell-main">
          <header className="app-header sticky top-0 z-30 h-14" />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
            {children}
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="app-canvas app-shell">
      {isAdmin ? <AdminSidebar /> : <UserSidebar />}
      <div className="app-shell-main">
        <AppHeader role={effectiveRole} email={effectiveEmail} />
        {isAdmin ? <AdminMobileNav /> : <UserMobileNav />}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
