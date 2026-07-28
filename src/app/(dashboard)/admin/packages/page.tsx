"use client";

import { useEffect, useState } from "react";

type Pkg = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  targetContents: number;
  _count: { projects: number };
};

const empty = {
  code: "",
  name: "",
  description: "",
  targetContents: 30,
};

export default function AdminPackagesPage() {
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [form, setForm] = useState(empty);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await fetch("/api/admin/packages");
    const data = await res.json();
    if (res.ok) setPackages(data.packages || []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const url = editId ? `/api/admin/packages/${editId}` : "/api/admin/packages";
    const method = editId ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        description: form.description || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Lưu thất bại");
      return;
    }
    setForm(empty);
    setEditId(null);
    await load();
  }

  function startEdit(p: Pkg) {
    setEditId(p.id);
    setForm({
      code: p.code,
      name: p.name,
      description: p.description || "",
      targetContents: p.targetContents,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Gói dịch vụ</h1>
        <p className="page-desc">
          Gói chỉ tính theo số bình luận Maps. Ảnh thư viện cố định tối đa 50 / dự án.
        </p>
      </div>

      <form onSubmit={save} className="panel grid gap-3 p-5 sm:grid-cols-2">
        {error && (
          <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)] sm:col-span-2">
            {error}
          </p>
        )}
        <label className="block space-y-1 text-sm">
          <span>Code *</span>
          <input
            className="input"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            required
            disabled={!!editId}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Tên *</span>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Số bình luận (gói) *</span>
          <input
            className="input"
            type="number"
            min={1}
            value={form.targetContents}
            onChange={(e) => setForm({ ...form, targetContents: Number(e.target.value) })}
            required
          />
        </label>
        <label className="block space-y-1 text-sm sm:col-span-2">
          <span>Mô tả</span>
          <input
            className="input"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <p className="text-xs text-[var(--muted)] sm:col-span-2">
          Ảnh: cố định 50 / dự án (không cấu hình theo gói).
        </p>
        <div className="flex gap-2 sm:col-span-2">
          <button type="submit" className="btn btn-primary">
            {editId ? "Cập nhật" : "Tạo gói"}
          </button>
          {editId && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setEditId(null);
                setForm(empty);
              }}
            >
              Hủy
            </button>
          )}
        </div>
      </form>

      <div className="panel overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Tên</th>
              <th>Bình luận</th>
              <th>Dự án</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.id}>
                <td className="font-mono font-medium">{p.code}</td>
                <td>{p.name}</td>
                <td className="font-mono text-xs">{p.targetContents}</td>
                <td>{p._count.projects}</td>
                <td>
                  <button type="button" className="link-accent text-sm" onClick={() => startEdit(p)}>
                    Sửa
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
