/**
 * Public app URL + internal APM API URL.
 * Deploy: set APP_URL (và NEXTAUTH_URL = cùng giá trị). API nội bộ giữ APM_API_URL.
 */

function stripTrailingSlash(url: string) {
  return url.replace(/\/$/, "");
}

/** Public web origin/URL — nguồn chính khi đổi domain. */
export function appUrl(): string {
  const raw =
    process.env.APP_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim() ||
    (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  if (!raw) {
    throw new Error("APP_URL or NEXTAUTH_URL must be set in production");
  }
  return stripTrailingSlash(raw);
}

/** Origin only (scheme + host[:port]) for redirects / CORS helpers. */
export function appOrigin(): string {
  try {
    return new URL(appUrl()).origin;
  } catch {
    return appUrl();
  }
}

/**
 * Nest APM base (server-side). Browser dùng `/apm-api` rewrite.
 * Production thường giữ http://127.0.0.1:4000/api (cùng máy / docker network).
 */
export function apmApiUrl(): string {
  const raw =
    process.env.APM_API_URL?.trim() ||
    (process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:4000/api");
  if (!raw) {
    throw new Error("APM_API_URL must be set in production");
  }
  return stripTrailingSlash(raw);
}
