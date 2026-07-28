"use client";

import { useEffect, useState } from "react";
type Template = {
  id: string;
  code: string;
  name: string;
  type: string;
  tone: string;
  bodySpin: string;
  isActive: boolean;
  _count: { campaigns: number };
};

const empty = {
  code: "",
  name: "",
  type: "OUTREACH_EMAIL",
  tone: "FRIENDLY",
  bodySpin: "",
  isActive: true,
};

export default function AdminTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [form, setForm] = useState(empty);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    const res = await fetch("/api/admin/templates");
    const data = await res.json();
    if (res.ok) setTemplates(data.templates || []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const url = editId ? `/api/admin/templates/${editId}` : "/api/admin/templates";
    const method = editId ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Lưu thất bại");
      return;
    }
    setMessage(editId ? "Đã cập nhật template" : "Đã tạo template");
    setForm(empty);
    setEditId(null);
    await load();
  }

  function startEdit(t: Template) {
    setEditId(t.id);
    setForm({
      code: t.code,
      name: t.name,
      type: t.type,
      tone: t.tone,
      bodySpin: t.bodySpin,
      isActive: t.isActive,
    });
  }

  async function deactivate(id: string) {
    await fetch(`/api/admin/templates/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Templates</h1>
        <p className="page-desc">
          Mẫu spin nội dung. Dùng {"{a|b}"} và {"[$brand_name]"}, {"[$tone_opener]"}.
        </p>
      </div>

      <form onSubmit={save} className="panel space-y-3 p-5">
        {error && (
          <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
        {message && (
          <p className="rounded-[var(--radius-sm)] bg-[var(--signal-soft)] px-3 py-2 text-sm text-[#087f5b]">
            {message}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-sm">
            <span>Code *</span>
            <input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Tên *</span>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Loại</span>
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="OUTREACH_EMAIL">OUTREACH_EMAIL</option>
              <option value="CONSULT_MESSAGE">CONSULT_MESSAGE</option>
              <option value="BRAND_COPY">BRAND_COPY</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span>Tone</span>
            <select className="input" value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })}>
              <option value="FORMAL">FORMAL</option>
              <option value="FRIENDLY">FRIENDLY</option>
              <option value="CASUAL">CASUAL</option>
            </select>
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span>Body spin *</span>
          <textarea
            className="input min-h-48 font-mono text-xs"
            value={form.bodySpin}
            onChange={(e) => setForm({ ...form, bodySpin: e.target.value })}
            required
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--ink-soft)]">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
          Đang active
        </label>
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary">
            {editId ? "Cập nhật" : "Tạo mới"}
          </button>
          {editId && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { setEditId(null); setForm(empty); }}
            >
              Hủy sửa
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
              <th>Tone</th>
              <th>Dùng</th>
              <th>Trạng thái</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td className="font-mono text-xs">{t.code}</td>
                <td>{t.name}</td>
                <td>
                  <span className="badge badge-accent">{t.tone}</span>
                </td>
                <td className="font-mono">{t._count.campaigns}</td>
                <td>
                  <span className={`badge ${t.isActive ? "badge-live" : "badge-neutral"}`}>
                    {t.isActive ? "Active" : "Off"}
                  </span>
                </td>
                <td>
                  <button type="button" className="link-accent text-sm" onClick={() => startEdit(t)}>
                    Sửa
                  </button>
                  {t.isActive && (
                    <button
                      type="button"
                      className="ml-3 text-sm text-[var(--danger)] underline"
                      onClick={() => void deactivate(t.id)}
                    >
                      Tắt
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
