"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandMark } from "@/components/BrandMark";

type Props = {
  businessCount?: number;
};

function BuildingIcon() {
  return (
    <svg className="h-4 w-4 shrink-0 opacity-80" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M4 21V9l8-6 8 6v12h-5v-6H9v6H4zm2-2h1v-4h2v4h2v-6H6v6zm10 0h2v-8h-6v2h2v2h2v4z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="h-4 w-4 shrink-0 opacity-80" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
    </svg>
  );
}

export function UserSidebar({ businessCount = 0 }: Props) {
  const pathname = usePathname();
  const [configOpen, setConfigOpen] = useState(true);
  const [count, setCount] = useState(businessCount);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    setCount(businessCount);
  }, [businessCount]);

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/businesses?countOnly=1")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && typeof d.total === "number") setCount(d.total);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const current = pendingHref ?? pathname;
  const projectsActive = current.startsWith("/app/projects");
  const businessActive = current.startsWith("/app/businesses");

  return (
    <aside className="admin-sidebar">
      <div className="border-b border-[var(--line)] px-4 py-5">
        <BrandMark href="/app" size="sm" />
        <p className="mt-4 flex items-center gap-2 text-xs text-[var(--muted)]">
          <span className="live-dot" />
          <span className="uppercase tracking-[0.14em]">Workspace</span>
        </p>
      </div>

      <nav className="flex flex-1 flex-col overflow-y-auto px-3 py-4">
        <p className="mb-2 px-2.5 text-xs uppercase tracking-[0.14em] text-[var(--muted)]">
          Điều hành
        </p>
        <Link
          href="/app/projects"
          prefetch
          onClick={() => setPendingHref("/app/projects")}
          className={`nav-item ${projectsActive ? "nav-item-active" : ""}`}
        >
          <FolderIcon />
          <span>Dự án</span>
        </Link>

        <button
          type="button"
          onClick={() => setConfigOpen((v) => !v)}
          className="mt-5 mb-2 flex w-full items-center justify-between gap-2 px-2.5 py-1 text-left"
        >
          <span className="text-xs uppercase leading-snug tracking-[0.12em] text-[var(--muted)]">
            Cấu hình thông tin đầu vào
          </span>
          <svg
            className={`h-3.5 w-3.5 shrink-0 text-[var(--muted)] transition ${configOpen ? "" : "rotate-180"}`}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden
          >
            <path
              fillRule="evenodd"
              d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.832 6.29 12.77a.75.75 0 11-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        {configOpen && (
          <Link
            href="/app/businesses"
            prefetch
            onClick={() => setPendingHref("/app/businesses")}
            className={`nav-item ${businessActive ? "nav-item-active" : ""}`}
          >
            <BuildingIcon />
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <span>Doanh nghiệp</span>
              <span
                className="rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-semibold tabular-nums text-[var(--accent-ink)]"
                title="Tổng số doanh nghiệp"
              >
                {count}
              </span>
            </span>
          </Link>
        )}
      </nav>
    </aside>
  );
}

export function UserMobileNav({ businessCount = 0 }: Props) {
  const pathname = usePathname();
  const [count, setCount] = useState(businessCount);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/businesses?countOnly=1")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && typeof d.total === "number") setCount(d.total);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const links = [
    { href: "/app/projects", label: "Dự án" },
    { href: "/app/businesses", label: `Doanh nghiệp (${count})` },
  ];
  const current = pendingHref ?? pathname;

  return (
    <div className="border-b border-[var(--line)] bg-[var(--header-bg)] backdrop-blur md:hidden">
      <nav className="flex gap-2 overflow-x-auto px-3 py-2.5">
        {links.map((l) => {
          const active = current.startsWith(l.href);
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
