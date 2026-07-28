"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { ClientOnly } from "@/components/ClientOnly";
import { ThemeToggle } from "@/components/ThemeToggle";

function RegisterFormFallback() {
  return (
    <div className="panel w-full max-w-[400px] space-y-5 p-7 sm:p-8">
      <div className="lg:hidden">
        <BrandMark size="md" />
      </div>
      <div>
        <h2 className="page-title">Đăng ký</h2>
        <p className="page-desc">Tạo tài khoản người dùng Binhluan.</p>
      </div>
      <div className="block space-y-1.5 text-sm text-[var(--ink-soft)]">
        <span className="font-medium">Họ tên</span>
        <div className="input h-10 opacity-60" />
      </div>
      <div className="block space-y-1.5 text-sm text-[var(--ink-soft)]">
        <span className="font-medium">Email</span>
        <div className="input h-10 opacity-60" />
      </div>
      <div className="block space-y-1.5 text-sm text-[var(--ink-soft)]">
        <span className="font-medium">Mật khẩu (≥8, có chữ và số)</span>
        <div className="input h-10 opacity-60" />
      </div>
      <div className="btn btn-primary w-full py-2.5 opacity-60">Tạo tài khoản</div>
      <p className="text-center text-sm text-[var(--muted)]">
        Đã có tài khoản? <span className="link-accent">Đăng nhập</span>
      </p>
    </div>
  );
}

function RegisterForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      setLoading(false);
      setError(data.error || "Đăng ký thất bại");
      return;
    }
    const login = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setLoading(false);
    if (login?.error) {
      router.push("/login");
      return;
    }
    router.push("/app");
    router.refresh();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="panel w-full max-w-[400px] space-y-5 p-7 sm:p-8"
    >
      <div className="lg:hidden">
        <BrandMark size="md" />
      </div>
      <div>
        <h2 className="page-title">Đăng ký</h2>
        <p className="page-desc">Tạo tài khoản người dùng Binhluan.</p>
      </div>
      {error && (
        <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      <label className="block space-y-1.5 text-sm text-[var(--ink-soft)]">
        <span className="font-medium">Họ tên</span>
        <input
          className="input"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label className="block space-y-1.5 text-sm text-[var(--ink-soft)]">
        <span className="font-medium">Email</span>
        <input
          className="input"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label className="block space-y-1.5 text-sm text-[var(--ink-soft)]">
        <span className="font-medium">Mật khẩu (≥8, có chữ và số)</span>
        <input
          className="input"
          type="password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <button type="submit" disabled={loading} className="btn btn-primary w-full py-2.5">
        {loading ? "Đang tạo…" : "Tạo tài khoản"}
      </button>
      <p className="text-center text-sm text-[var(--muted)]">
        Đã có tài khoản?{" "}
        <Link href="/login" className="link-accent">
          Đăng nhập
        </Link>
      </p>
    </form>
  );
}

export default function RegisterPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_0.95fr]">
      <section className="auth-brand-side relative hidden overflow-hidden bg-[#0c1222] text-white lg:flex lg:flex-col lg:justify-between lg:px-12 lg:py-12 xl:px-16">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(700px 420px at 30% 20%, rgb(14 154 167 / 32%), transparent 60%), radial-gradient(480px 360px at 80% 80%, rgb(18 184 134 / 18%), transparent 55%)",
          }}
        />
        <div className="relative">
          <BrandMark size="lg" inverted />
        </div>
        <div className="relative max-w-md">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-white/50">
            Workspace
          </p>
          <h1 className="font-display mt-4 text-4xl font-semibold leading-[1.1] tracking-tight">
            Tạo workspace để quản lý dự án và nội dung.
          </h1>
          <p className="mt-4 text-[15px] text-white/65">
            Một tài khoản — theo dõi gói, media và tiến độ sinh nội dung.
          </p>
          <div className="mt-8 signal-bar" />
        </div>
        <p className="relative font-mono text-xs text-white/35">Binhluan · register</p>
      </section>

      <section className="app-canvas relative flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
          <ThemeToggle />
        </div>
        <ClientOnly fallback={<RegisterFormFallback />}>
          <RegisterForm />
        </ClientOnly>
      </section>
    </div>
  );
}
