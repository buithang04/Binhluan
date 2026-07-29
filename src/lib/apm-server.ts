/** Server-side APM API calls (login as bootstrap admin). */

import { apmApiUrl } from "@/lib/urls";

const APM_URL = () => apmApiUrl();

let cached: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null = null;

function readJwtExpMs(accessToken: string): number | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8",
      ),
    ) as { exp?: number };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function loginServiceAdmin(): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const email =
    process.env.APM_ADMIN_EMAIL ||
    (process.env.NODE_ENV !== "production" ? "admin@apm.local" : undefined);
  const password =
    process.env.APM_ADMIN_PASSWORD ||
    (process.env.NODE_ENV !== "production" ? "Admin@123" : undefined);
  if (!email || !password) {
    throw new Error("APM_ADMIN_EMAIL and APM_ADMIN_PASSWORD must be set");
  }
  // service:true — không tăng sessionVersion (không đá Admin trên trình duyệt)
  const res = await fetch(`${APM_URL()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, service: true }),
  });
  if (!res.ok) {
    throw new Error(`APM login failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { accessToken: string; refreshToken: string };
}

async function refreshServiceAdmin(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${APM_URL()}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken?: string };
    return data.accessToken || null;
  } catch {
    return null;
  }
}

async function getApmAdminToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  if (cached?.refreshToken) {
    const next = await refreshServiceAdmin(cached.refreshToken);
    if (next) {
      const exp = readJwtExpMs(next);
      cached = {
        accessToken: next,
        refreshToken: cached.refreshToken,
        expiresAt: exp ?? Date.now() + 50 * 60_000,
      };
      return next;
    }
  }

  const data = await loginServiceAdmin();
  const exp = readJwtExpMs(data.accessToken);
  cached = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: exp ?? Date.now() + 50 * 60_000,
  };
  return data.accessToken;
}

export async function apmServerFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getApmAdminToken();
  const res = await fetch(`${APM_URL()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    // Token bị đá (hiếm) → login service lại 1 lần
    if (res.status === 401) {
      cached = null;
      const retryToken = await getApmAdminToken();
      const retry = await fetch(`${APM_URL()}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${retryToken}`,
          ...(init?.headers || {}),
        },
      });
      if (!retry.ok) {
        let msg = await retry.text();
        try {
          const j = JSON.parse(msg) as { message?: string | string[] };
          if (Array.isArray(j.message)) msg = j.message.join(", ");
          else if (j.message) msg = j.message;
        } catch {
          /* keep */
        }
        throw new Error(msg || `APM HTTP ${retry.status}`);
      }
      if (retry.status === 204) return undefined as T;
      return (await retry.json()) as T;
    }
    let msg = await res.text();
    try {
      const j = JSON.parse(msg) as { message?: string | string[] };
      if (Array.isArray(j.message)) msg = j.message.join(", ");
      else if (j.message) msg = j.message;
    } catch {
      /* keep */
    }
    throw new Error(msg || `APM HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
