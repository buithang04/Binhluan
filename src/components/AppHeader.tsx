"use client";

import { signOut } from "next-auth/react";
import { ThemeToggle } from "@/components/ThemeToggle";

type Props = {
  /** Từ server layout — khớp SSR/client, không đọc useSession lúc hydrate. */
  role?: string;
  email?: string | null;
};

export function AppHeader({ role, email }: Props) {
  const isAdmin = role === "ADMIN";

  return (
    <header className="app-header sticky top-0 z-30">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          {isAdmin ? (
            <span className="hidden items-center gap-2 text-xs text-[var(--muted)] sm:inline-flex">
              <span className="live-dot" />
              <span className="uppercase tracking-wider">Bảng điều khiển</span>
            </span>
          ) : (
            <span className="hidden items-center gap-2 text-xs text-[var(--muted)] sm:inline-flex">
              <span className="live-dot" />
              <span className="uppercase tracking-wider">Workspace</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle compact />
          <span className="hidden max-w-[200px] truncate text-sm text-[var(--muted)] sm:inline">
            {email ?? "\u00a0"}
          </span>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="btn btn-secondary btn-sm"
          >
            Đăng xuất
          </button>
        </div>
      </div>
    </header>
  );
}
