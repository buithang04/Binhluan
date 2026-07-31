"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export type ProjectListItem = {
  id: string;
  brandName: string;
  status: string;
  packageCode: string;
  productCount: number;
  mediaCount: number;
  userEmail?: string | null;
  generated: number;
  target: number;
  percent: number;
  /** Đã sinh nội dung → ẩn thùng rác (user list) */
  contentGenerated: boolean;
};

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0v12a1 1 0 001 1h6a1 1 0 001-1V7M10 11v6M14 11v6"
      />
    </svg>
  );
}

type Props = {
  initialProjects: ProjectListItem[];
  isAdmin?: boolean;
};

export function ProjectListClient({ initialProjects, isAdmin }: Props) {
  const router = useRouter();
  const [projects, setProjects] = useState(initialProjects);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function deleteProject(p: ProjectListItem) {
    if (p.contentGenerated) return;
    if (!window.confirm(`Xóa dự án “${p.brandName}”?`)) return;

    setDeletingId(p.id);
    setError("");
    try {
      const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Xóa thất bại");
        return;
      }
      setProjects((rows) => rows.filter((r) => r.id !== p.id));
      router.refresh();
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setDeletingId(null);
    }
  }

  if (projects.length === 0) {
    return (
      <div className="panel-muted border-dashed px-6 py-14 text-center">
        <p className="font-display text-lg font-semibold text-[var(--ink)]">Chưa có dự án</p>
        <p className="mt-1 text-sm text-[var(--muted)]">Tạo dự án đầu tiên để bắt đầu pipeline.</p>
        <Link href="/app/projects/new" className="btn btn-primary mt-5">
          Tạo dự án
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      <ul className="space-y-3">
        {projects.map((p) => (
          <li key={p.id}>
            <div className="panel flex items-center gap-3 px-4 py-4 transition hover:border-[var(--accent)] hover:shadow-[var(--shadow-md)]">
              <Link href={`/app/projects/${p.id}`} className="min-w-0 flex-1">
                <p className="font-display text-[1.05rem] font-semibold tracking-tight text-[var(--ink)]">
                  {p.brandName}
                </p>
                <p className="mt-0.5 text-sm text-[var(--muted)]">
                  Gói {p.packageCode} · {p.productCount} SP · {p.mediaCount} ảnh
                  {isAdmin && p.userEmail ? ` · ${p.userEmail}` : ""}
                </p>
                <div className="mt-3 flex items-center gap-2 text-xs text-[var(--ink-soft)]">
                  <div className="progress-track w-28">
                    <div
                      className="progress-fill"
                      style={{ width: `${p.percent}%` }}
                    />
                  </div>
                  <span className="font-mono">
                    {p.generated}/{p.target} ({p.percent}%)
                  </span>
                </div>
              </Link>
              {!p.contentGenerated && (
                <button
                  type="button"
                  title="Xóa dự án"
                  aria-label={`Xóa dự án ${p.brandName}`}
                  disabled={deletingId === p.id}
                  className="shrink-0 self-start rounded-[var(--radius-sm)] p-2 text-[var(--ink-soft)] transition hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] disabled:opacity-50"
                  onClick={() => void deleteProject(p)}
                >
                  <TrashIcon className="h-5 w-5" />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
