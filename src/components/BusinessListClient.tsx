"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BusinessForm, type BusinessSaved } from "@/components/BusinessForm";
import styles from "./BusinessList.module.css";

type BusinessRow = {
  id: string;
  brandName: string;
  website: string | null;
  targetAudience: string;
  brandDescription: string;
  targetMarket: string;
  writingNotes: string | null;
  isActive: boolean;
  products: { id: string; name: string; description: string }[];
};

type StatusFilter = "all" | "active" | "inactive";
type SortDir = "asc" | "desc";
type ColKey = "brandName" | "targetAudience" | "website" | "status";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const COL_STORAGE_KEY = "biz-list-columns";
const DEFAULT_COLS: Record<ColKey, boolean> = {
  brandName: true,
  targetAudience: true,
  website: true,
  status: false,
};
const COL_LABELS: { key: ColKey; label: string; locked?: boolean }[] = [
  { key: "brandName", label: "Brand Name", locked: true },
  { key: "targetAudience", label: "Target Audience" },
  { key: "website", label: "Website" },
  { key: "status", label: "Trạng thái" },
];

function loadCols(): Record<ColKey, boolean> {
  if (typeof window === "undefined") return { ...DEFAULT_COLS };
  try {
    const raw = localStorage.getItem(COL_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COLS };
    const parsed = JSON.parse(raw) as Partial<Record<ColKey, boolean>>;
    return {
      brandName: true,
      targetAudience: parsed.targetAudience !== false,
      website: parsed.website !== false,
      status: parsed.status === true,
    };
  } catch {
    return { ...DEFAULT_COLS };
  }
}

function IconEye() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7L8 5z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
    </svg>
  );
}

export function BusinessListClient() {
  const router = useRouter();
  const [rows, setRows] = useState<BusinessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const [viewId, setViewId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filterOpen, setFilterOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [cols, setCols] = useState<Record<ColKey, boolean>>(DEFAULT_COLS);
  const [portalReady, setPortalReady] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    setPortalReady(true);
    router.prefetch("/app/businesses/new");
  }, [router]);

  useEffect(() => {
    setCols(loadCols());
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(cols));
    } catch {
      /* ignore */
    }
  }, [cols]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      const res = await fetch(`/api/businesses?${params}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Không tải được danh sách");
        return;
      }
      setRows(data.businesses || []);
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false);
      if (!colsRef.current?.contains(e.target as Node)) setColsOpen(false);
    }
    if (filterOpen || colsOpen) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [filterOpen, colsOpen]);

  function toggleCol(key: ColKey) {
    if (key === "brandName") return;
    setCols((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const visibleColCount =
    1 + // actions
    (cols.brandName ? 1 : 0) +
    (cols.targetAudience ? 1 : 0) +
    (cols.website ? 1 : 0) +
    (cols.status ? 1 : 0);

  const filtered = useMemo(() => {
    let list = [...rows];
    if (statusFilter === "active") list = list.filter((b) => b.isActive);
    if (statusFilter === "inactive") list = list.filter((b) => !b.isActive);
    list.sort((a, b) => {
      const cmp = a.brandName.localeCompare(b.brandName, "vi");
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [rows, statusFilter, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = filtered.length === 0 ? 0 : (safePage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, filtered.length);
  const pageRows = filtered.slice(pageStart, pageEnd);
  const filterCount = statusFilter === "all" ? 0 : 1;

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const viewing = useMemo(
    () => (viewId ? rows.find((r) => r.id === viewId) ?? null : null),
    [viewId, rows],
  );
  const editing = useMemo(
    () => (editId ? rows.find((r) => r.id === editId) ?? null : null),
    [editId, rows],
  );

  function openEdit(id: string) {
    setViewId(null);
    setEditId(id);
  }

  function applySaved(business: BusinessSaved) {
    setRows((prev) => {
      const mapped = prev.map((b) => {
        if (b.id !== business.id) {
          return business.isActive ? { ...b, isActive: false } : b;
        }
        return {
          ...b,
          brandName: business.brandName,
          website: business.website,
          brandDescription: business.brandDescription,
          targetAudience: business.targetAudience,
          targetMarket: business.targetMarket,
          writingNotes: business.writingNotes,
          isActive: business.isActive,
          products: (business.products || []).map((p, i) => ({
            id: `${business.id}-${i}`,
            name: p.name,
            description: p.description,
          })),
        };
      });
      return mapped;
    });
    setEditId(null);
    setMsg(`Đã lưu “${business.brandName}”.`);
    void load({ silent: true });
  }

  async function activate(id: string) {
    const snapshot = rowsRef.current;
    const target = snapshot.find((b) => b.id === id);
    if (!target) return;

    setBusyId(id);
    setError("");
    setMsg("");
    // Optimistic: cập nhật UI ngay
    setRows((prev) =>
      prev.map((b) => ({
        ...b,
        isActive: b.id === id,
      })),
    );

    try {
      const res = await fetch(`/api/businesses/${id}/activate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setRows(snapshot);
        setError(data.error || "Không đặt Active được");
        return;
      }
      setMsg(`Đã đặt “${data.business.brandName}” Active — tạo dự án sẽ tự điền.`);
    } catch {
      setRows(snapshot);
      setError("Không kết nối được máy chủ");
    } finally {
      setBusyId(null);
    }
  }

  async function deactivate(id: string) {
    const snapshot = rowsRef.current;
    const target = snapshot.find((b) => b.id === id);
    if (!target) return;

    setBusyId(id);
    setError("");
    setMsg("");
    setRows((prev) =>
      prev.map((b) => (b.id === id ? { ...b, isActive: false } : b)),
    );

    try {
      const res = await fetch(`/api/businesses/${id}/deactivate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setRows(snapshot);
        setError(data.error || "Không bỏ Active được");
        return;
      }
      setMsg(`Đã chuyển “${data.business.brandName}” sang Inactive.`);
    } catch {
      setRows(snapshot);
      setError("Không kết nối được máy chủ");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <p className={styles.crumb}>Doanh nghiệp / Danh sách</p>
          <h1 className="page-title" style={{ marginTop: "0.25rem" }}>
            Doanh nghiệp
          </h1>
        </div>
        <Link href="/app/businesses/new" className="btn btn-primary">
          Tạo mới
        </Link>
      </div>

      {error && <p className={`${styles.alert} ${styles.alertDanger}`}>{error}</p>}
      {msg && <p className={`${styles.alert} ${styles.alertOk}`}>{msg}</p>}

      <div className={`panel ${styles.card}`}>
        <div className={styles.toolbar}>
          <div className={styles.search}>
            <span className={styles.searchIcon}>
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M10 2a8 8 0 015.29 13.9l4.4 4.41-1.42 1.42-4.4-4.4A8 8 0 1110 2zm0 2a6 6 0 100 12A6 6 0 0010 4z" />
              </svg>
            </span>
            <input
              className={`input ${styles.searchInput}`}
              placeholder="Tìm kiếm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <div className={styles.filterWrap} ref={filterRef}>
            <button
              type="button"
              className={styles.toolBtn}
              aria-label="Bộ lọc"
              onClick={() => {
                setFilterOpen((v) => !v);
                setColsOpen(false);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M4 5h16l-6 7v5l-4 2v-7L4 5z" />
              </svg>
              <span className={styles.badge}>{filterCount}</span>
            </button>
            {filterOpen && (
              <div className={styles.filterPop}>
                <div className={styles.filterHead}>
                  <span className={styles.filterTitle}>Bộ lọc</span>
                  <button
                    type="button"
                    className={styles.filterReset}
                    onClick={() => {
                      setStatusFilter("all");
                      setPage(1);
                    }}
                  >
                    Đặt lại
                  </button>
                </div>
                <label className={styles.filterLabel}>
                  <span>Trạng thái</span>
                  <select
                    className="input"
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value as StatusFilter);
                      setPage(1);
                    }}
                  >
                    <option value="all">Tất cả</option>
                    <option value="active">Active (Đang kích hoạt)</option>
                    <option value="inactive">Inactive (Không kích hoạt)</option>
                  </select>
                </label>
              </div>
            )}
          </div>

          <div className={styles.filterWrap} ref={colsRef}>
            <button
              type="button"
              className={styles.toolBtn}
              aria-label="Cột hiển thị"
              title="Cột hiển thị"
              onClick={() => {
                setColsOpen((v) => !v);
                setFilterOpen(false);
              }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M4 4h4v16H4V4zm6 0h4v16h-4V4zm6 0h4v16h-4V4z" />
              </svg>
            </button>
            {colsOpen && (
              <div className={styles.filterPop}>
                <div className={styles.filterHead}>
                  <span className={styles.filterTitle}>Cột hiển thị</span>
                  <button
                    type="button"
                    className={styles.filterReset}
                    onClick={() => setCols({ ...DEFAULT_COLS })}
                  >
                    Đặt lại
                  </button>
                </div>
                <div className={styles.colList}>
                  {COL_LABELS.map((c) => (
                    <label
                      key={c.key}
                      className={`${styles.colItem}${c.locked ? ` ${styles.colItemMuted}` : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={cols[c.key]}
                        disabled={c.locked}
                        onChange={() => toggleCol(c.key)}
                      />
                      <span>{c.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={styles.scroll}>
          <table className={`data-table ${styles.table}`}>
            <thead>
              <tr>
                <th className={styles.colActions} />
                {cols.brandName && (
                  <th>
                    <button
                      type="button"
                      className={styles.sortBtn}
                      onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                    >
                      Brand Name
                      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M7 10l5 5 5-5H7z" />
                      </svg>
                    </button>
                  </th>
                )}
                {cols.targetAudience && <th>Target Audience</th>}
                {cols.website && <th>Website</th>}
                {cols.status && <th>Trạng thái</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={visibleColCount} className={styles.empty}>
                    Đang tải…
                  </td>
                </tr>
              ) : pageRows.length === 0 ? (
                <tr>
                  <td colSpan={visibleColCount} className={styles.empty}>
                    Chưa có doanh nghiệp.{" "}
                    <Link href="/app/businesses/new" className="link-accent">
                      Tạo mới
                    </Link>
                  </td>
                </tr>
              ) : (
                pageRows.map((b) => (
                  <tr key={b.id}>
                    <td className={styles.colActions}>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className={`${styles.act} ${styles.actView}`}
                          onClick={() => setViewId(b.id)}
                        >
                          <IconEye />
                          <span>Xem</span>
                        </button>
                        <button
                          type="button"
                          className={`${styles.act} ${styles.actEdit}`}
                          onClick={() => openEdit(b.id)}
                        >
                          <IconEdit />
                          <span>Sửa</span>
                        </button>
                        {b.isActive ? (
                          <button
                            type="button"
                            disabled={busyId === b.id}
                            className={`${styles.act} ${styles.actInactive}`}
                            onClick={() => void deactivate(b.id)}
                          >
                            <IconPause />
                            <span>{busyId === b.id ? "…" : "Chuyển Inactive"}</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busyId === b.id}
                            className={`${styles.act} ${styles.actActive}`}
                            onClick={() => void activate(b.id)}
                          >
                            <IconPlay />
                            <span>{busyId === b.id ? "…" : "Chuyển Active"}</span>
                          </button>
                        )}
                      </div>
                    </td>
                    {cols.brandName && <td className={styles.brand}>{b.brandName}</td>}
                    {cols.targetAudience && (
                      <td className={styles.audience} title={b.targetAudience}>
                        {b.targetAudience || "—"}
                      </td>
                    )}
                    {cols.website && (
                      <td className={styles.website}>
                        {b.website ? (
                          <a href={b.website} target="_blank" rel="noreferrer">
                            {b.website}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    )}
                    {cols.status && (
                      <td className={styles.audience}>
                        {b.isActive ? "Active" : "Inactive"}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className={styles.footer}>
          <p className={styles.footerText}>
            {filtered.length === 0
              ? "Đang hiển thị 0 kết quả"
              : `Đang hiển thị từ ${pageStart + 1} đến ${pageEnd} của ${filtered.length} kết quả`}
          </p>
          <div className={styles.footerRight}>
            <label className={styles.pageSize}>
              <span>Mỗi trang</span>
              <select
                className="input"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value) as (typeof PAGE_SIZE_OPTIONS)[number]);
                  setPage(1);
                }}
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.pager}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Trước
              </button>
              <span className={styles.pageInfo}>
                {safePage}/{totalPages}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Sau
              </button>
            </div>
          </div>
        </div>
      </div>

      {portalReady &&
        viewing &&
        createPortal(
          <div
            className={styles.modalBackdrop}
            onClick={() => setViewId(null)}
            role="presentation"
          >
            <div
              className={styles.modal}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="biz-view-title"
            >
              <div className={styles.filterHead} style={{ marginBottom: "1rem" }}>
                <div>
                  <h2
                    id="biz-view-title"
                    style={{ margin: 0, fontSize: "1.15rem", color: "var(--ink)" }}
                  >
                    {viewing.brandName}
                  </h2>
                  <span
                    style={{
                      display: "inline-block",
                      marginTop: "0.5rem",
                      borderRadius: 6,
                      padding: "0.15rem 0.5rem",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      background: viewing.isActive
                        ? "var(--accent-soft)"
                        : "var(--badge-neutral-bg)",
                      color: viewing.isActive ? "var(--accent-ink)" : "var(--muted)",
                    }}
                  >
                    {viewing.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setViewId(null)}
                >
                  Đóng
                </button>
              </div>
              <dl style={{ margin: 0, display: "grid", gap: "0.75rem", fontSize: "var(--fs-sm)" }}>
                <div>
                  <dt style={{ marginBottom: 4, color: "var(--muted)" }}>Website</dt>
                  <dd style={{ margin: 0 }}>{viewing.website || "—"}</dd>
                </div>
                <div>
                  <dt style={{ marginBottom: 4, color: "var(--muted)" }}>Target Audience</dt>
                  <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                    {viewing.targetAudience || "—"}
                  </dd>
                </div>
                <div>
                  <dt style={{ marginBottom: 4, color: "var(--muted)" }}>Target Market</dt>
                  <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                    {viewing.targetMarket || "—"}
                  </dd>
                </div>
                <div>
                  <dt style={{ marginBottom: 4, color: "var(--muted)" }}>Mô tả</dt>
                  <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                    {viewing.brandDescription || "—"}
                  </dd>
                </div>
                <div>
                  <dt style={{ marginBottom: 4, color: "var(--muted)" }}>Sản phẩm</dt>
                  <dd style={{ margin: 0 }}>
                    <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem" }}>
                      {viewing.products.map((p) => (
                        <li key={p.id} style={{ marginBottom: 6 }}>
                          <strong>{p.name}</strong> — {p.description}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              </dl>
              <div className={styles.modalActions}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => openEdit(viewing.id)}
                >
                  Sửa
                </button>
                {viewing.isActive ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busyId === viewing.id}
                    onClick={() => void deactivate(viewing.id)}
                  >
                    Chuyển Inactive
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busyId === viewing.id}
                    onClick={() => void activate(viewing.id)}
                  >
                    Chuyển Active
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {portalReady &&
        editing &&
        createPortal(
          <div
            className={styles.modalBackdrop}
            onClick={() => setEditId(null)}
            role="presentation"
          >
            <div
              className={`${styles.modal} ${styles.modalWide}`}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="biz-edit-title"
            >
              <div className={styles.filterHead} style={{ marginBottom: "1rem" }}>
                <div>
                  <h2
                    id="biz-edit-title"
                    style={{ margin: 0, fontSize: "1.15rem", color: "var(--ink)" }}
                  >
                    Sửa doanh nghiệp
                  </h2>
                  <p style={{ margin: "0.35rem 0 0", fontSize: "var(--fs-sm)", color: "var(--muted)" }}>
                    {editing.brandName}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setEditId(null)}
                >
                  Đóng
                </button>
              </div>
              <BusinessForm
                key={editing.id}
                mode="edit"
                initial={{
                  id: editing.id,
                  brandName: editing.brandName,
                  website: editing.website,
                  brandDescription: editing.brandDescription,
                  targetAudience: editing.targetAudience,
                  targetMarket: editing.targetMarket,
                  writingNotes: editing.writingNotes,
                  isActive: editing.isActive,
                  products: editing.products.map((p) => ({
                    name: p.name,
                    description: p.description,
                  })),
                }}
                onCancel={() => setEditId(null)}
                onSaved={applySaved}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
