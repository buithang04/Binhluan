import { useUiStore } from "./store";

const BASE = "/api";

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken, email, role, setAuth, clearAuth } = useUiStore.getState();
  if (!refreshToken) {
    clearAuth();
    return null;
  }

  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    clearAuth();
    return null;
  }

  const data = (await res.json()) as { accessToken: string };
  setAuth({
    accessToken: data.accessToken,
    refreshToken,
    email: email || "",
    role: role || "",
  });
  return data.accessToken;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
  retried = false,
): Promise<T> {
  const token = useUiStore.getState().accessToken;
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 401 && !path.startsWith("/auth/") && !retried) {
    refreshPromise ??= refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
    const next = await refreshPromise;
    if (next) return api<T>(path, options, true);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<T>;
}
