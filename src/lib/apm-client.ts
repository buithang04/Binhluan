/** Browser-side APM calls via Next rewrite `/apm-api` → Nest. */

import { apmApiUrl } from "@/lib/urls";

export function apmBase() {
  return typeof window !== "undefined" ? "/apm-api" : apmApiUrl();
}

export async function apmFetch<T = unknown>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${apmBase()}${path}`, {
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
      /* keep text */
    }
    if (res.status === 401) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("apm:token-expired"));
      }
      throw new Error(
        "Unauthorized — token APM hết hạn. Thử lại sau vài giây hoặc đăng nhập lại.",
      );
    }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
