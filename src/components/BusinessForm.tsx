"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type BusinessProductInput = { name: string; description: string };

export type BusinessFormInitial = {
  id?: string;
  brandName: string;
  website: string | null;
  brandDescription: string;
  targetAudience: string;
  targetMarket: string;
  writingNotes: string | null;
  isActive?: boolean;
  products: BusinessProductInput[];
};

export type BusinessSaved = BusinessFormInitial & {
  id: string;
  isActive: boolean;
  products: { id?: string; name: string; description: string }[];
};

type Props = {
  mode: "create" | "edit";
  initial?: BusinessFormInitial;
  /** Khi có: Hủy gọi callback (modal) thay vì điều hướng. */
  onCancel?: () => void;
  /** Khi có: sau lưu thành công gọi callback thay vì điều hướng. */
  onSaved?: (business: BusinessSaved) => void;
};

const emptyProduct = { name: "", description: "" };

export function BusinessForm({ mode, initial, onCancel, onSaved }: Props) {
  const router = useRouter();
  const [pendingNav, startNav] = useTransition();
  const [brandName, setBrandName] = useState(initial?.brandName || "");
  const [website, setWebsite] = useState(initial?.website || "");
  const [brandDescription, setBrandDescription] = useState(initial?.brandDescription || "");
  const [targetAudience, setTargetAudience] = useState(initial?.targetAudience || "");
  const [targetMarket, setTargetMarket] = useState(initial?.targetMarket || "");
  const [writingNotes, setWritingNotes] = useState(initial?.writingNotes || "");
  const [setActive, setSetActive] = useState(initial?.isActive ?? mode === "create");
  const [products, setProducts] = useState<BusinessProductInput[]>(
    initial?.products?.length ? initial.products : [{ ...emptyProduct }],
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function updateProduct(index: number, field: keyof BusinessProductInput, value: string) {
    setProducts((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }

  function handleCancel() {
    if (onCancel) {
      onCancel();
      return;
    }
    startNav(() => {
      router.replace("/app/businesses");
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    const payload = {
      brandName,
      website: website.trim() || null,
      brandDescription,
      targetAudience,
      targetMarket,
      writingNotes: writingNotes.trim() || null,
      products,
      setActive,
    };
    try {
      const url = mode === "create" ? "/api/businesses" : `/api/businesses/${initial!.id}`;
      const method = mode === "create" ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Lưu thất bại");
        return;
      }
      const business = data.business as BusinessSaved;
      if (onSaved) {
        onSaved(business);
        return;
      }
      startNav(() => {
        router.replace("/app/businesses");
      });
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {error && (
        <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">Brand Name *</span>
          <input
            className="input"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            required
            minLength={2}
          />
        </label>
        <label className="block space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">Website</span>
          <input
            className="input"
            type="url"
            placeholder="https://"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">Mô tả doanh nghiệp</span>
          <textarea
            className="input min-h-24"
            value={brandDescription}
            onChange={(e) => setBrandDescription(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Target Audience</span>
          <textarea
            className="input min-h-20"
            value={targetAudience}
            onChange={(e) => setTargetAudience(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Target Market</span>
          <textarea
            className="input min-h-20"
            value={targetMarket}
            onChange={(e) => setTargetMarket(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">Ghi chú viết nội dung</span>
          <textarea
            className="input min-h-20"
            value={writingNotes}
            onChange={(e) => setWritingNotes(e.target.value)}
          />
        </label>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--ink)]">Sản phẩm</h2>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setProducts((rows) => [...rows, { ...emptyProduct }])}
          >
            Thêm sản phẩm
          </button>
        </div>
        {products.map((p, i) => (
          <div
            key={i}
            className="grid gap-3 rounded-[var(--radius-sm)] border border-[var(--line)] p-3 sm:grid-cols-2"
          >
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Tên *</span>
              <input
                className="input"
                value={p.name}
                onChange={(e) => updateProduct(i, "name", e.target.value)}
                required
                minLength={2}
              />
            </label>
            <label className="block space-y-1 text-sm sm:col-span-2">
              <span className="font-medium">Mô tả *</span>
              <textarea
                className="input min-h-16"
                value={p.description}
                onChange={(e) => updateProduct(i, "description", e.target.value)}
                required
                minLength={10}
              />
            </label>
            {products.length > 1 && (
              <button
                type="button"
                className="text-sm text-[var(--danger)] sm:col-span-2"
                onClick={() => setProducts((rows) => rows.filter((_, j) => j !== i))}
              >
                Xóa sản phẩm
              </button>
            )}
          </div>
        ))}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={setActive}
          onChange={(e) => setSetActive(e.target.checked)}
        />
        <span>Đặt Active — tự điền khi tạo dự án mới</span>
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={saving || pendingNav} className="btn btn-primary">
          {saving ? "Đang lưu…" : mode === "create" ? "Tạo doanh nghiệp" : "Lưu thay đổi"}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-secondary" onClick={handleCancel} disabled={saving}>
            Hủy
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={handleCancel} disabled={saving || pendingNav}>
            {pendingNav ? "Đang về…" : "Hủy"}
          </button>
        )}
      </div>
    </form>
  );
}
