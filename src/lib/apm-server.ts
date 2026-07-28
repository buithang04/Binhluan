/** Server-side APM API calls (login as bootstrap admin). */

import { apmApiUrl } from "@/lib/urls";

const APM_URL = () => apmApiUrl();

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getApmAdminToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const email = process.env.APM_ADMIN_EMAIL || (process.env.NODE_ENV !== "production" ? "admin@apm.local" : undefined);
  const password = process.env.APM_ADMIN_PASSWORD || (process.env.NODE_ENV !== "production" ? "Admin@123" : undefined);
  if (!email || !password) {
    throw new Error("APM_ADMIN_EMAIL and APM_ADMIN_PASSWORD must be set");
  }
  const res = await fetch(`${APM_URL()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`APM login failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { accessToken: string };
  cachedToken = {
    token: data.accessToken,
    expiresAt: Date.now() + 50 * 60_000,
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
