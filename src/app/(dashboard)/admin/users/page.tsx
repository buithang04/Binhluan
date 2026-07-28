"use client";

import { useEffect, useState } from "react";

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "USER";
  isActive: boolean;
  lastLoginAt: string | null;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
  _count: { projects: number };
};

const emptyForm = {
  name: "",
  email: "",
  password: "",
  role: "USER" as "ADMIN" | "USER",
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("vi-VN");
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    const res = await fetch("/api/admin/users");
    const data = await res.json();
    if (res.ok) setUsers(data.users || []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error || "Tạo user thất bại");
      return;
    }
    setForm(emptyForm);
    await load();
  }

  async function toggleActive(u: UserRow) {
    setError("");
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !u.isActive }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Cập nhật thất bại");
      return;
    }
    await load();
  }

  async function changeRole(u: UserRow, role: "ADMIN" | "USER") {
    if (u.role === role) return;
    setError("");
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Đổi quyền thất bại");
      return;
    }
    await load();
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!resetId) return;
    setError("");
    const res = await fetch(`/api/admin/users/${resetId}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: resetPw }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Đặt lại mật khẩu thất bại");
      return;
    }
    setResetId(null);
    setResetPw("");
  }

  async function removeUser(u: UserRow) {
    if (!confirm(`Xóa user ${u.email}?`)) return;
    setError("");
    const res = await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Xóa thất bại");
      return;
    }
    await load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Quản lý người dùng</h1>
        <p className="page-desc">
          Tạo tài khoản, phân quyền ADMIN/USER, khóa/mở, đặt lại mật khẩu. Đăng ký công khai đã tắt mặc định.
        </p>
      </div>

      {error && (
        <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      <form onSubmit={createUser} className="panel grid gap-3 p-5 sm:grid-cols-2">
        <h2 className="text-sm font-semibold sm:col-span-2">Thêm user mới</h2>
        <label className="block space-y-1 text-sm">
          <span>Họ tên *</span>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Email *</span>
          <input
            className="input"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Mật khẩu * (≥8 ký tự, chữ + số)</span>
          <input
            className="input"
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            minLength={8}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Quyền</span>
          <select
            className="input"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as "ADMIN" | "USER" })}
          >
            <option value="USER">USER — Khách hàng</option>
            <option value="ADMIN">ADMIN — Quản trị</option>
          </select>
        </label>
        <div className="sm:col-span-2">
          <button type="submit" disabled={loading} className="btn btn-primary">
            {loading ? "Đang tạo…" : "Tạo user"}
          </button>
        </div>
      </form>

      {resetId && (
        <form onSubmit={resetPassword} className="panel space-y-3 p-5">
          <h2 className="text-sm font-semibold">Đặt lại mật khẩu</h2>
          <input
            className="input"
            type="password"
            placeholder="Mật khẩu mới"
            value={resetPw}
            onChange={(e) => setResetPw(e.target.value)}
            required
            minLength={8}
          />
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary">
              Lưu mật khẩu
            </button>
            <button type="button" className="btn" onClick={() => { setResetId(null); setResetPw(""); }}>
              Hủy
            </button>
          </div>
        </form>
      )}

      <div className="panel overflow-x-auto">
        <table className="data-table w-full min-w-[720px]">
          <thead>
            <tr>
              <th>Email</th>
              <th>Tên</th>
              <th>Quyền</th>
              <th>Trạng thái</th>
              <th>Đăng nhập cuối</th>
              <th>Dự án</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="font-mono text-sm">{u.email}</td>
                <td>{u.name || "—"}</td>
                <td>
                  <select
                    className="input py-1 text-sm"
                    value={u.role}
                    onChange={(e) => void changeRole(u, e.target.value as "ADMIN" | "USER")}
                  >
                    <option value="USER">USER</option>
                    <option value="ADMIN">ADMIN</option>
                  </select>
                </td>
                <td>
                  {u.lockedUntil && new Date(u.lockedUntil) > new Date() ? (
                    <span className="font-medium text-[var(--danger)]">Khóa tạm</span>
                  ) : u.isActive ? (
                    <span className="font-medium text-[var(--signal-ink)]">Hoạt động</span>
                  ) : (
                    <span className="font-medium text-[var(--muted)]">Vô hiệu</span>
                  )}
                </td>
                <td className="text-sm text-[var(--muted)]">{fmtDate(u.lastLoginAt)}</td>
                <td>{u._count.projects}</td>
                <td>
                  <div className="action-btns justify-end">
                    <button
                      type="button"
                      className="action-btn action-btn-edit"
                      title="Đặt lại mật khẩu"
                      onClick={() => setResetId(u.id)}
                    >
                      MK
                    </button>
                    <button
                      type="button"
                      className="action-btn action-btn-edit"
                      title={u.isActive ? "Vô hiệu hóa tài khoản" : "Mở lại tài khoản"}
                      onClick={() => void toggleActive(u)}
                    >
                      {u.isActive ? "Khóa" : "Mở"}
                    </button>
                    <button
                      type="button"
                      className="action-btn action-btn-danger"
                      title="Xóa user"
                      onClick={() => void removeUser(u)}
                    >
                      Xóa
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!users.length && (
          <p className="p-4 text-sm text-[var(--muted)]">Chưa có user nào.</p>
        )}
      </div>
    </div>
  );
}
