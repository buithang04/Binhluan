"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";

type AdminRow = {
  id: string;
  brandName: string;
  userEmail: string;
  packageCode: string;
  status: string;
  generated: number;
  target: number;
  percent: number;
  contentGenerated: boolean;
};

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
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

export default function AdminDashboardPage() {
  const { data: session, status } = useSession();
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/admin/projects", { credentials: "include" });
      const data = await r.json().catch(() => ({}));
      if (r.status === 401) {
        setError("Phiên đăng nhập hết hạn — thử tải lại trang");
        return;
      }
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setRows(Array.isArray(data.projects) ? data.projects : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "loading") return;
    if (status !== "authenticated" || !session?.user?.id) {
      setLoading(false);
      setError("Chưa đăng nhập");
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, session?.user?.id]);

  async function deleteProject(r: AdminRow) {
    const warn = r.contentGenerated
      ? `Dự án “${r.brandName}” đã sinh nội dung. Xác nhận xóa vĩnh viễn?`
      : `Xóa dự án “${r.brandName}”?`;
    if (!window.confirm(warn)) return;

    setDeletingId(r.id);
    setError("");
    try {
      const res = await fetch(`/api/projects/${r.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Xóa thất bại");
        return;
      }
      setRows((list) => list.filter((x) => x.id !== r.id));
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Tiến độ dự án</h1>
          <p className="page-desc">
            Theo dõi bình luận Maps đã đăng theo gói (completed / hạn mức gói).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-secondary !py-1.5"
            disabled={loading}
            onClick={() => void load()}
          >
            Làm mới
          </button>
          <span className="badge badge-live">
            <span className="live-dot !h-1.5 !w-1.5 !animate-none" />
            Live
          </span>
        </div>
      </div>

      {error && (
        <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {loading ? (
        <div className="panel px-4 py-10 text-center text-sm text-[var(--muted)]">
          Đang tải…
        </div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Dự án</th>
                <th>User</th>
                <th>Gói</th>
                <th>Bình luận</th>
                <th>%</th>
                <th className="sticky-actions-col whitespace-nowrap">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/app/projects/${r.id}`} className="link-accent">
                      {r.brandName}
                    </Link>
                  </td>
                  <td className="font-mono text-xs text-[var(--muted)]">
                    {r.userEmail}
                  </td>
                  <td>
                    <span className="badge badge-accent">{r.packageCode}</span>
                  </td>
                  <td className="font-mono">
                    {r.generated}/{r.target}
                  </td>
                  <td>
                    <div className="flex min-w-[7rem] items-center gap-2">
                      <div className="progress-track w-20">
                        <div
                          className="progress-fill"
                          style={{ width: `${r.percent}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs">{r.percent}%</span>
                    </div>
                  </td>
                  <td className="sticky-actions-col">
                    <div className="action-btns">
                      <button
                        type="button"
                        title={
                          r.contentGenerated
                            ? "Xóa (đã sinh nội dung — cần xác nhận)"
                            : "Xóa dự án"
                        }
                        aria-label={`Xóa dự án ${r.brandName}`}
                        disabled={deletingId === r.id}
                        className="action-btn action-btn-danger gap-1.5 !w-auto !min-w-[5.5rem]"
                        onClick={() => void deleteProject(r)}
                      >
                        <TrashIcon />
                        Xóa
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && !error && (
            <p className="px-4 py-10 text-center text-sm text-[var(--muted)]">
              Chưa có dự án
            </p>
          )}
        </div>
      )}
    </div>
  );
}
