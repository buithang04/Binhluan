"use client";

import { SessionProvider, signOut, useSession } from "next-auth/react";
import { useEffect, useRef, type ReactNode } from "react";
import type { Session } from "next-auth";
import { ThemeProvider } from "@/lib/theme";

/** Gia hạn sliding idle + refresh APM — mỗi 5 phút khi tab đang mở. */
const SESSION_KEEPALIVE_MS = 5 * 60 * 1000;

function SessionKeepAlive({ children }: { children: ReactNode }) {
  const { data: session, status, update } = useSession();
  const updateRef = useRef(update);
  updateRef.current = update;
  const startedRef = useRef(false);
  const signingOutRef = useRef(false);
  /** Chỉ redirect sau khi đã từng qua loading — tránh race lúc reload. */
  const sawLoadingRef = useRef(status === "loading");

  function redirectToLogin() {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    void signOut({ callbackUrl: "/login" });
  }

  useEffect(() => {
    if (status === "loading") sawLoadingRef.current = true;
  }, [status]);

  useEffect(() => {
    if (
      session?.error === "IdleTimeout" ||
      session?.error === "ApmAuthExpired" ||
      session?.error === "SessionSuperseded"
    ) {
      redirectToLogin();
    }
  }, [session?.error]);

  // Phiên mất trên dashboard → về login (chỉ sau khi session đã resolve)
  useEffect(() => {
    if (status === "loading") return;
    if (status !== "unauthenticated") return;
    if (!sawLoadingRef.current) return;
    const path = window.location.pathname;
    if (path.startsWith("/admin") || path.startsWith("/app")) {
      window.location.assign("/login");
    }
  }, [status]);

  // Gia hạn khi quay lại tab / cửa sổ (bổ sung refetchOnWindowFocus)
  useEffect(() => {
    if (status !== "authenticated") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void updateRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [status]);

  // Keep-alive định kỳ 5 phút
  useEffect(() => {
    if (status !== "authenticated" || startedRef.current) return;
    startedRef.current = true;

    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void updateRef.current();
    }, SESSION_KEEPALIVE_MS);

    function onExpired() {
      void (async () => {
        try {
          const next = await updateRef.current({ reason: "apm-401" });
          if (
            !next ||
            next.error === "IdleTimeout" ||
            next.error === "ApmAuthExpired" ||
            next.error === "SessionSuperseded" ||
            (next.user?.role === "ADMIN" && !next.apmAccessToken)
          ) {
            redirectToLogin();
          }
        } catch {
          // Lỗi mạng tạm — không đá login
        }
      })();
    }
    window.addEventListener("apm:token-expired", onExpired);

    return () => {
      window.clearInterval(id);
      window.removeEventListener("apm:token-expired", onExpired);
      startedRef.current = false;
    };
  }, [status]);

  return children;
}

export function Providers({
  children,
  session,
}: {
  children: ReactNode;
  /** Không default = null — null = NextAuth coi như đã logout ngay khi mount. */
  session?: Session | null;
}) {
  return (
    <ThemeProvider>
      <SessionProvider
        session={session}
        refetchInterval={0}
        refetchOnWindowFocus
      >
        <SessionKeepAlive>{children}</SessionKeepAlive>
      </SessionProvider>
    </ThemeProvider>
  );
}
