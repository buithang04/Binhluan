"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandMark } from "@/components/BrandMark";

const links = [
  { href: "/admin", label: "Tiến độ", hint: "Dự án" },
  { href: "/admin/users", label: "Người dùng", hint: "Tài khoản app" },
  { href: "/admin/accounts", label: "Tài khoản", hint: "Gmail" },
  { href: "/admin/proxies", label: "Proxy", hint: "Mạng" },
  { href: "/admin/profiles", label: "Hồ sơ", hint: "Trình duyệt" },
  { href: "/admin/jobs", label: "Công việc", hint: "Hàng đợi" },
  { href: "/admin/deepseek", label: "DeepSeek", hint: "AI / Prompt" },
  { href: "/admin/packages", label: "Gói dịch vụ", hint: "Gói" },
];

function NavIcon({ index }: { index: number }) {
  const paths = [
    "M4 14h4v6H4zm6-8h4v14h-4zm6 4h4v10h-4z",
    "M12 4a4 4 0 110 8 4 4 0 010-8zm-6 10a6 6 0 1112 0v1H6v-1z",
    "M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4 0-8 2-8 4v2h16v-2c0-2-4-4-8-4z",
    "M4 8h16v2H4zm2 4h12v8H6z",
    "M5 5h14v10H5zm3 12h8v2H8z",
    "M4 6h16v2H4zm0 5h10v2H4zm0 5h14v2H4z",
    "M5 4h14v4H5zm0 6h14v10H5z",
    "M4 7h16v2H4zm0 4h10v2H4zm0 4h16v2H4z",
  ];
  return (
    <svg className="nav-ico h-4 w-4 shrink-0 opacity-80" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={paths[index % paths.length]} />
    </svg>
  );
}

function usePendingHref() {
  const pathname = usePathname();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);
  return { pathname, pendingHref, setPendingHref };
}

function isNavActive(pathname: string, href: string, pendingHref: string | null) {
  const current = pendingHref ?? pathname;
  return href === "/admin" ? current === "/admin" : current.startsWith(href);
}

export function AdminSidebar() {
  const { pathname, pendingHref, setPendingHref } = usePendingHref();

  return (
    <aside className="admin-sidebar">
      <div className="border-b border-[var(--line)] px-4 py-4">
        <BrandMark href="/admin" size="sm" />
        <p className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)]">
          <span className="live-dot" />
          <span className="uppercase tracking-[0.14em]">Tự động hóa</span>
        </p>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 py-3">
        <p className="mb-1 px-2 text-xs uppercase tracking-[0.14em] text-[var(--muted)]">
          Điều khiển
        </p>
        {links.map((l, i) => {
          const active = isNavActive(pathname, l.href, pendingHref);
          return (
            <Link
              key={l.href}
              href={l.href}
              prefetch
              onClick={() => setPendingHref(l.href)}
              aria-busy={pendingHref === l.href}
              className={`nav-item ${active ? "nav-item-active" : ""} ${pendingHref === l.href ? "opacity-80" : ""}`}
            >
              <NavIcon index={i} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="leading-tight">{l.label}</span>
                <span className="text-xs font-normal uppercase tracking-wider opacity-60">
                  {l.hint}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-[var(--line)] px-4 py-3">
        <p className="text-xs text-[var(--muted)]">v1 · console</p>
      </div>
    </aside>
  );
}

export function AdminMobileNav() {
  const { pathname, pendingHref, setPendingHref } = usePendingHref();
  return (
    <div className="border-b border-[var(--line)] bg-[var(--header-bg)] backdrop-blur md:hidden">
      <nav className="flex gap-1 overflow-x-auto px-3 py-2">
        {links.map((l) => {
          const active = isNavActive(pathname, l.href, pendingHref);
          return (
            <Link
              key={l.href}
              href={l.href}
              prefetch
              onClick={() => setPendingHref(l.href)}
              className={`nav-item shrink-0 whitespace-nowrap !py-1.5 text-xs ${active ? "nav-item-active" : ""}`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Shim — sidebar lives in dashboard layout */
export function AdminNav() {
  return null;
}
