import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { apmApiUrl } from "@/lib/urls";
import { prisma } from "@/lib/prisma";

const APM_URL = () => apmApiUrl();

function authOriginIsHttps(): boolean {
  const raw = process.env.APP_URL?.trim() || process.env.NEXTAUTH_URL?.trim() || "";
  if (!raw) return process.env.NODE_ENV === "production";
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return raw.toLowerCase().startsWith("https://");
  }
}

const USE_SECURE_AUTH_COOKIE = authOriginIsHttps();

/** Chỉ logout khi không dùng trong khoảng này (sliding idle). */
const SESSION_IDLE_SECONDS = Number(process.env.SESSION_IDLE_HOURS || 24) * 60 * 60;
/** Kiểm tra ADMIN còn đúng sessionVersion (thiết bị khác đăng nhập → đá). */
const SESSION_VERSION_CHECK_MS = 60_000;
/** Viết lại cookie / chạy jwt callback tối đa mỗi N giây khi có request session. */
const SESSION_UPDATE_AGE_SECONDS = 5 * 60;

/** Read `exp` from a JWT without verifying (Nest already signed it). */
function readJwtExp(accessToken: string): number | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8",
      ),
    ) as { exp?: number };
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

function accessTokenNeedsRefresh(accessToken: string | undefined): boolean {
  if (!accessToken) return true;
  const exp = readJwtExp(accessToken);
  if (exp == null) return true;
  // Chỉ refresh khi còn ≤30s — tránh chặn mọi request khi buffer 2 phút
  return exp * 1000 < Date.now() + 30_000;
}

type ApmRefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; fatal: boolean };

async function refreshApmAccess(refreshToken: string): Promise<ApmRefreshResult> {
  try {
    const res = await fetch(`${APM_URL()}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { accessToken?: string };
      if (data.accessToken) return { ok: true, accessToken: data.accessToken };
    }
    // 401/403 = refresh token thật sự hết hạn; 5xx/khác = tạm, giữ phiên NextAuth
    const fatal = res.status === 401 || res.status === 403;
    return { ok: false, fatal };
  } catch (e) {
    console.error("[auth] APM refresh failed (transient)", e);
    return { ok: false, fatal: false };
  }
}

/**
 * Login qua Nest API (Postgres).
 * Session = sliding idle (mặc định 24h không dùng mới hết).
 * Access APM ngắn (~1h), tự refresh khi user còn hoạt động (mở tab / refetch session).
 */
export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    maxAge: SESSION_IDLE_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
  },
  cookies: {
    sessionToken: {
      name:
        USE_SECURE_AUTH_COOKIE
          ? "__Secure-next-auth.session-token"
          : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: USE_SECURE_AUTH_COOKIE,
      },
    },
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) return null;
        const email = credentials.email.toLowerCase().trim();
        const password = credentials.password;

        try {
          const res = await fetch(`${APM_URL()}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
            signal: AbortSignal.timeout(4000),
          });
          if (!res.ok) return null;
          const data = (await res.json()) as {
            accessToken?: string;
            refreshToken?: string;
            user?: {
              id: string;
              email: string;
              role: string;
              name?: string | null;
              sessionVersion?: number;
            };
          };
          if (!data.user?.id || !data.accessToken) return null;
          return {
            id: data.user.id,
            email: data.user.email,
            name: data.user.name ?? null,
            role: data.user.role,
            apmAccessToken: data.accessToken,
            apmRefreshToken: data.refreshToken,
            sessionVersion: data.user.sessionVersion,
          };
        } catch (e) {
          console.error("[auth] Nest login failed", e);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      const now = Date.now();

      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role;
        token.apmAccessToken = (user as { apmAccessToken?: string }).apmAccessToken;
        token.apmRefreshToken = (user as { apmRefreshToken?: string }).apmRefreshToken;
        token.sessionVersion = (user as { sessionVersion?: number }).sessionVersion;
        token.lastActivityAt = now;
        token.lastSessionCheckAt = now;
        delete token.error;
        return token;
      }

      // NextAuth dùng `sub`; đảm bảo luôn có `id`
      if (!token.id && token.sub) token.id = token.sub;

      // Session cũ chưa có lastActivityAt → khởi tạo, không idle-out nhầm
      if (token.id && typeof token.lastActivityAt !== "number") {
        token.lastActivityAt = now;
        return token;
      }

      const last = token.lastActivityAt as number;
      if (token.id && now - last > SESSION_IDLE_SECONDS * 1000) {
        return {
          ...token,
          error: "IdleTimeout" as const,
          apmAccessToken: undefined,
          apmRefreshToken: undefined,
        };
      }

      // Slide idle — không gọi Nest ở đây (tránh chậm mọi getSession / soft-nav)
      if (token.id) token.lastActivityAt = now;

      // ADMIN: 1 thiết bị — so khớp sessionVersion với DB (tối đa mỗi 60s / khi update)
      if (
        token.role === "ADMIN" &&
        token.id &&
        typeof token.sessionVersion === "number"
      ) {
        const lastSvCheck = (token.lastSessionCheckAt as number) || 0;
        if (
          trigger === "update" ||
          now - lastSvCheck > SESSION_VERSION_CHECK_MS
        ) {
          token.lastSessionCheckAt = now;
          const row = await prisma.user.findUnique({
            where: { id: token.id as string },
            select: { sessionVersion: true, isActive: true },
          });
          if (!row?.isActive || row.sessionVersion !== token.sessionVersion) {
            delete token.apmAccessToken;
            delete token.apmRefreshToken;
            token.error = "SessionSuperseded";
            return token;
          }
        }
      }

      const updatePayload = session as { reason?: string } | undefined;
      const forceApmRefresh = trigger === "update" && updatePayload?.reason === "apm-401";

      // Refresh APM khi gần hết hạn, hoặc khi client báo 401
      if (
        (trigger === "update" || trigger === "signIn") &&
        token.id &&
        token.role === "ADMIN" &&
        token.apmRefreshToken &&
        (forceApmRefresh ||
          accessTokenNeedsRefresh(token.apmAccessToken as string | undefined))
      ) {
        const next = await refreshApmAccess(token.apmRefreshToken as string);
        if (next.ok) {
          token.apmAccessToken = next.accessToken;
          delete token.error;
        } else if (next.fatal) {
          // Refresh token thật sự chết — mới đá login
          delete token.apmAccessToken;
          delete token.apmRefreshToken;
          token.error = "ApmAuthExpired";
        }
        // Lỗi mạng / timeout: giữ token cũ, không logout
      } else if (forceApmRefresh && token.role === "ADMIN" && !token.apmRefreshToken) {
        delete token.apmAccessToken;
        token.error = "ApmAuthExpired";
      }

      return token;
    },
    async session({ session, token }) {
      if (
        token.error === "IdleTimeout" ||
        token.error === "ApmAuthExpired" ||
        token.error === "SessionSuperseded"
      ) {
        session.user = { id: "", email: null, name: null, role: undefined };
        session.apmAccessToken = undefined;
        session.error = token.error;
        return session;
      }

      const id = (token.id || token.sub) as string | undefined;
      if (!id) {
        session.apmAccessToken = undefined;
        return session;
      }

      if (session.user) {
        session.user.id = id;
        session.user.role = token.role as string | undefined;
      }
      session.apmAccessToken = token.apmAccessToken as string | undefined;
      return session;
    },
  },
};
