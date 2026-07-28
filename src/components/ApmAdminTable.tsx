"use client";

import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";
import { apmFetch } from "@/lib/apm-client";

type Props = {
  title: string;
  /** @deprecated unused — kept for call-site compat */
  active?: string;
  path: string;
  columns: { key: string; label: string; render?: (row: Record<string, unknown>) => React.ReactNode }[];
};

export function ApmAdminTable({ title, path, columns }: Props) {
  const { data: session, status: sessionStatus } = useSession();
  const token = session?.apmAccessToken;
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (sessionStatus === "loading") return;
    setLoading(true);
    setError("");
    if (!token) {
      setError("Chưa có token APM — đăng xuất rồi đăng nhập lại bằng admin@apm.local / Admin@123");
      setLoading(false);
      return;
    }
    try {
      const data = await apmFetch<unknown>(path, token);
      const list = Array.isArray(data)
        ? data
        : ((data as { items?: unknown[]; jobs?: unknown[] })?.items ||
            (data as { jobs?: unknown[] })?.jobs ||
            []);
      setRows(list as Record<string, unknown>[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [path, token, sessionStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-desc">Dữ liệu realtime từ automation API.</p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary">
          Refresh
        </button>
      </div>
      {error && (
        <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      {loading ? (
        <div className="panel px-4 py-10 text-center text-sm text-[var(--muted)]">Đang tải…</div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={String(row.id ?? i)}>
                  {columns.map((c) => (
                    <td key={c.key}>
                      {c.render
                        ? c.render(row)
                        : String(
                            c.key.includes(".")
                              ? (c.key
                                  .split(".")
                                  .reduce(
                                    (a: unknown, k) => (a as Record<string, unknown>)?.[k],
                                    row,
                                  ) ?? "—")
                              : (row[c.key] ?? "—"),
                          )}
                    </td>
                  ))}
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={columns.length} className="!py-10 text-center text-[var(--muted)]">
                    Không có dữ liệu
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
