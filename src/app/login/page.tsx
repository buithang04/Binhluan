"use client";

import Link from "next/link";
import { getSession, signIn } from "next-auth/react";import { useRouter } from "next/navigation";
import { useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { ClientOnly } from "@/components/ClientOnly";
import { ThemeToggle } from "@/components/ThemeToggle";

function AuthChrome({
  children,
  brand,
}: {
  children: React.ReactNode;
  brand: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_0.95fr]">
      {brand}
      <section className="app-canvas relative flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
          <ThemeToggle />
        </div>
        {children}
      </section>
    </div>
  );
}

function LoginBrand() {
  return (
    <section className="auth-brand-side relative hidden overflow-hidden bg-[#0c1222] text-white lg:flex lg:flex-col lg:justify-between lg:px-12 lg:py-12 xl:px-16">
      <div
        className="pointer-events-none absolute inset-0 opacity-80"
        style={{
          background:
            "radial-gradient(700px 420px at 20% 15%, rgb(14 154 167 / 35%), transparent 60%), radial-gradient(520px 380px at 85% 75%, rgb(18 184 134 / 22%), transparent 55%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.22]"
        style={{
          backgroundImage:
            "linear-gradient(rgb(255 255 255 / 6%) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 6%) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />
      <div className="relative">
        <BrandMark size="lg" inverted />
      </div>
      <div className="relative max-w-md">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-white/50">
          Automation console
        </p>
        <h1 className="font-display mt-4 text-4xl font-semibold leading-[1.1] tracking-tight xl:text-[2.75rem]">
          Vận hành hệ thống cản thiện góc nhìn khách hàng
        </h1>
        <div className="mt-8 signal-bar" />
        <div className="mt-6 flex items-center gap-2 text-xs text-white/55">
          <span className="live-dot" />
          Hệ thống sẵn sàng
        </div>
      </div>
      <p className="relative font-mono text-xs text-white/35">Binhluan · ops</p>
    </section>
  );
}

function LoginFormFallback() {
  return (
    <div className="panel w-full max-w-[400px] space-y-5 p-7 sm:p-8">
      <div className="lg:hidden">
        <BrandMark size="md" />
      </div>
      <div>
        <h2 className="page-title">Đăng nhập</h2>
        <p className="page-desc">Truy cập console tự động hóa Binhluan.</p>
      </div>
      <div className="block space-y-1.5 text-sm text-[var(--ink-soft)]">
        <span className="font-medium">Email</span>
        <div className="input h-10 opacity-60" />
      </div>
      <div className="block space-y-1.5 text-sm text-[var(--ink-soft)]">
        <span className="font-medium">Mật khẩu</span>
        <div className="input h-10 opacity-60" />
      </div>
      <div className="btn btn-primary w-full py-2.5 opacity-60">Vào console</div>
      <p className="text-center text-sm text-[var(--muted)]">
        Chưa có tài khoản? <span className="link-accent">Đăng ký</span>
      </p>
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setLoading(false);
    if (res?.error) {
      setError("Email hoặc mật khẩu không đúng");
      return;
    }
    const session = await getSession();
    const dest = session?.user?.role === "ADMIN" ? "/admin" : "/app";
    router.replace(dest);
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
        <h2 className="page-title">Đăng nhập</h2>
        <p className="page-desc">Truy cập console tự động hóa Binhluan.</p>
      </div>
      {error && (
        <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      <label className="block space-y-1.5 text-sm text-[var(--ink-soft)]">
        <span className="font-medium">Email</span>
        <input
          className="input"
          type="email"
          autoComplete="email"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label className="block space-y-1.5 text-sm text-[var(--ink-soft)]">
        <span className="font-medium">Mật khẩu</span>
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          name="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <button type="submit" disabled={loading} className="btn btn-primary w-full py-2.5">
        {loading ? "Đang đăng nhập…" : "Vào console"}
      </button>
      <p className="text-center text-sm text-[var(--muted)]">
        {process.env.NEXT_PUBLIC_ALLOW_PUBLIC_REGISTER === "true" ? (
          <>
            Chưa có tài khoản?{" "}
            <Link href="/register" className="link-accent">
              Đăng ký
            </Link>
          </>
        ) : (
          <>Liên hệ quản trị viên để được cấp tài khoản.</>
        )}
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthChrome brand={<LoginBrand />}>
      <ClientOnly fallback={<LoginFormFallback />}>
        <LoginForm />
      </ClientOnly>
    </AuthChrome>
  );
}
